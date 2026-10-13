/**
 * Forward-only schema migrations. Each migration runs in its own transaction and
 * is recorded in `schema_migrations`; never edit a released migration — append a
 * new version instead.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V1 } from './schema-v1.ts';

export interface Migration {
  readonly version: number;
  readonly up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: (db) => db.exec(SCHEMA_V1) }];

export interface MigrationResult {
  readonly applied: readonly number[];
  /** Highest version recorded in the database (may exceed the known list after a downgrade). */
  readonly currentVersion: number;
  readonly latestKnownVersion: number;
}

function assertOrdered(migrations: readonly Migration[]): void {
  for (let i = 1; i < migrations.length; i += 1) {
    const previous = migrations[i - 1];
    const current = migrations[i];
    if (previous && current && current.version <= previous.version) {
      throw new Error(`migrations must have strictly increasing versions (${current.version})`);
    }
  }
}

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[], now: () => number): MigrationResult {
  assertOrdered(migrations);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  ) STRICT`);
  const done = new Set<number>();
  for (const row of db.prepare('SELECT version FROM schema_migrations').all()) {
    if (typeof row['version'] === 'number') done.add(row['version']);
  }
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const applied: number[] = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      record.run(migration.version, now());
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    done.add(migration.version);
    applied.push(migration.version);
  }
  const latestKnownVersion = migrations.at(-1)?.version ?? 0;
  return { applied, currentVersion: Math.max(0, ...done), latestKnownVersion };
}
