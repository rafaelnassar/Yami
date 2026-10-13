/**
 * Opens `<dataDir>/yami.db` with the connection settings the host relies on and
 * brings the schema up to date.
 *
 * - A corrupted database (not a database / malformed / failed `quick_check`) is
 *   moved aside and recreated, then every readable row is salvaged from the
 *   moved copy (database-salvage), so the host always starts; the caller
 *   reports `{ recovered, backupPath, salvage }` to the user.
 * - A database written by a newer build (schema version above the known
 *   migrations) is refused with `DATABASE_TOO_NEW` before anything is written:
 *   this build cannot know what the newer schema expects, and a read-only mode
 *   would make every command fail halfway instead.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, ErrorCode } from '../../../shared/kernel/errors.ts';
import type { Logger } from '../../application/ports/system.ts';
import { salvageDatabase, type SalvageBudget, type SalvageReport } from './database-salvage.ts';
import { MIGRATIONS, runMigrations, type Migration } from './migrations.ts';
import { describeError } from './silent-logger.ts';

export const DATABASE_FILE_NAME = 'yami.db';

export interface OpenDatabaseOptions {
  readonly file: string;
  readonly logger: Logger;
  readonly now: () => number;
  readonly migrations?: readonly Migration[];
  /** Bounds the salvage of a corrupted database (default `DEFAULT_SALVAGE_BUDGET`). */
  readonly salvageBudget?: SalvageBudget;
}

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  readonly recovered: boolean;
  readonly backupPath: string | null;
  /** What could be copied from the corrupted database (`null` unless `recovered`). */
  readonly salvage: SalvageReport | null;
}

/** Raised when `PRAGMA quick_check` reports problems. */
export class DatabaseCorruptionError extends Error {
  constructor(detail: string) {
    super(`database integrity check failed: ${detail}`);
    this.name = 'DatabaseCorruptionError';
  }
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export function isCorruptionError(error: unknown): boolean {
  if (error instanceof DatabaseCorruptionError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode === 'number') {
    // Extended result codes keep the primary code in the low byte.
    const primary = errcode & 0xff;
    return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
  }
  const message = error instanceof Error ? error.message : '';
  return /file is not a database|database disk image is malformed/i.test(message);
}

function closeQuietly(db: DatabaseSync | null): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* already closed or never opened */
  }
}

function quickCheck(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA quick_check').all();
  const messages = rows.map((row) => String(Object.values(row)[0] ?? ''));
  if (messages.length !== 1 || messages[0] !== 'ok') {
    throw new DatabaseCorruptionError(messages.slice(0, 5).join('; ').slice(0, 500));
  }
}

/** Highest schema version recorded in the file (0 for a new or pre-migration file). */
function recordedSchemaVersion(db: DatabaseSync): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return 0;
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.['version'];
  return typeof version === 'number' ? version : 0;
}

/** Refuses (before any write) a database whose schema a newer build created. */
function assertSchemaKnown(db: DatabaseSync, migrations: readonly Migration[], logger: Logger): void {
  const version = recordedSchemaVersion(db);
  const known = migrations.at(-1)?.version ?? 0;
  if (version <= known) return;
  logger.error('database schema is newer than this build; refusing to open it', { version, known });
  throw new AppError(ErrorCode.DATABASE_TOO_NEW, { version, known });
}

function configure(db: DatabaseSync, options: OpenDatabaseOptions): void {
  const migrations = options.migrations ?? MIGRATIONS;
  // busy_timeout first so the remaining statements already wait on locks.
  db.exec('PRAGMA busy_timeout = 5000');
  assertSchemaKnown(db, migrations, options.logger);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  quickCheck(db);
  const result = runMigrations(db, migrations, options.now);
  if (result.applied.length > 0) {
    options.logger.info('database migrated', { applied: result.applied.join(',') });
  }
}

function openConfigured(options: OpenDatabaseOptions): DatabaseSync {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(options.file);
    configure(db, options);
    return db;
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
}

function freeBackupPath(file: string, timestamp: number): string {
  let candidate = `${file}.corrupt-${timestamp}`;
  for (let n = 1; existsSync(candidate); n += 1) candidate = `${file}.corrupt-${timestamp}-${n}`;
  return candidate;
}

/** Renames the database and its WAL/SHM side files; returns the new main file path. */
function moveAside(file: string, timestamp: number): string {
  const backup = freeBackupPath(file, timestamp);
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(file + suffix)) renameSync(file + suffix, backup + suffix);
  }
  return backup;
}

export function openSqliteDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  mkdirSync(path.dirname(options.file), { recursive: true });
  try {
    return { db: openConfigured(options), recovered: false, backupPath: null, salvage: null };
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    const backupPath = moveAside(options.file, options.now());
    options.logger.error('database is corrupted; moved aside and recreated', {
      error: describeError(error),
      backup: path.basename(backupPath)
    });
    const db = openConfigured(options);
    const salvage = salvageDatabase({
      source: backupPath,
      target: db,
      logger: options.logger,
      ...(options.salvageBudget ? { budget: options.salvageBudget } : {})
    });
    return { db, recovered: true, backupPath, salvage };
  }
}
