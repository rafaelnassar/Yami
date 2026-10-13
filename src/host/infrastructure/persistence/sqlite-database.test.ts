import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppError, ErrorCode } from '../../../shared/kernel/errors.ts';
import { silentLogger } from './silent-logger.ts';
import { DATABASE_FILE_NAME, isCorruptionError, openSqliteDatabase } from './sqlite-database.ts';
import { MIGRATIONS, runMigrations, type Migration } from './migrations.ts';
import { captureLogger, downloadRecord, makeTempDir, openTestPersistence } from './test-fixtures.ts';

function downloadRecordForCorruption(i: number): ReturnType<typeof downloadRecord> {
  return downloadRecord({ id: `d${i}`, title: `title-${i}`.repeat(20), position: i, updatedAt: i });
}

describe('openSqliteDatabase', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('creates the schema with the expected pragmas and records v1', () => {
    const file = path.join(dir, DATABASE_FILE_NAME);
    const { db, recovered, backupPath } = openSqliteDatabase({ file, logger: silentLogger(), now: () => 42 });
    try {
      assert.equal(recovered, false);
      assert.equal(backupPath, null);
      assert.equal(db.prepare('PRAGMA journal_mode').get()?.['journal_mode'], 'wal');
      assert.equal(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'], 1);
      assert.equal(db.prepare('PRAGMA busy_timeout').get()?.['timeout'], 5000);
      assert.equal(db.prepare('PRAGMA synchronous').get()?.['synchronous'], 1);
      const versions = db.prepare('SELECT version, applied_at FROM schema_migrations').all();
      assert.deepEqual(
        versions.map((row) => ({ ...row })),
        [{ version: 1, applied_at: 42 }]
      );
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row['name']);
      for (const table of ['batches', 'conversation_events', 'downloads', 'folders', 'media_files', 'settings']) {
        assert.ok(tables.includes(table), `missing table ${table}`);
      }
    } finally {
      db.close();
    }
  });

  it('is idempotent on reopen and applies only new migrations', () => {
    const file = path.join(dir, DATABASE_FILE_NAME);
    openSqliteDatabase({ file, logger: silentLogger(), now: () => 1 }).db.close();
    const extra: Migration = { version: 2, up: (db) => db.exec('CREATE TABLE extra (x INTEGER) STRICT') };
    const { db } = openSqliteDatabase({
      file,
      logger: silentLogger(),
      now: () => 2,
      migrations: [...MIGRATIONS, extra]
    });
    try {
      const versions = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(
        versions.map((row) => ({ ...row })),
        [
          { version: 1, applied_at: 1 },
          { version: 2, applied_at: 2 }
        ]
      );
    } finally {
      db.close();
    }
  });

  it('rolls back a failing migration and leaves earlier ones applied', () => {
    const db = new DatabaseSync(':memory:');
    const broken: Migration = {
      version: 2,
      up: (conn) => {
        conn.exec('CREATE TABLE half (x INTEGER)');
        throw new Error('boom');
      }
    };
    assert.throws(() => runMigrations(db, [...MIGRATIONS, broken], () => 0), /boom/);
    const versions = db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row['version']);
    assert.deepEqual(versions, [1]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
    db.close();
  });

  it('rejects unordered migration lists', () => {
    const db = new DatabaseSync(':memory:');
    const noop = (): void => undefined;
    assert.throws(() =>
      runMigrations(
        db,
        [
          { version: 2, up: noop },
          { version: 1, up: noop }
        ],
        () => 0
      )
    );
    db.close();
  });

  it('recovers from a garbage file by moving it aside', () => {
    const file = path.join(dir, DATABASE_FILE_NAME);
    writeFileSync(file, 'definitely not sqlite '.repeat(200));
    writeFileSync(`${file}-wal`, 'stale wal');
    const { logger, entries } = captureLogger();
    const { db, recovered, backupPath, salvage } = openSqliteDatabase({ file, logger, now: () => 1234 });
    try {
      assert.equal(recovered, true);
      assert.equal(salvage?.opened, false, 'nothing to salvage from a non-database');
      assert.equal(backupPath, `${file}.corrupt-1234`);
      assert.ok(backupPath && existsSync(backupPath));
      // SQLite may drop the stale WAL when the broken connection closes; it must never reach the new db.
      if (existsSync(`${file}-wal`)) assert.notEqual(readFileSync(`${file}-wal`, 'utf8'), 'stale wal');
      assert.match(readFileSync(backupPath, 'utf8'), /definitely not sqlite/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get()?.['n'], 0);
      assert.ok(entries.some((entry) => entry.level === 'error'));
    } finally {
      db.close();
    }
  });

  it('recovers when quick_check finds a damaged page and salvages every row of intact tables', () => {
    const file = path.join(dir, DATABASE_FILE_NAME);
    const first = openTestPersistence(dir);
    const { downloads, tx } = first.context;
    tx.transaction(() => {
      for (let i = 0; i < 400; i += 1) {
        downloads.save({ ...downloadRecordForCorruption(i) });
      }
    });
    first.context.close();
    const bytes = readFileSync(file);
    const pageSize = 4096;
    bytes.fill(0xff, pageSize * 3, pageSize * 3 + 64);
    writeFileSync(file, bytes);

    const { db, recovered, backupPath, salvage } = openSqliteDatabase({ file, logger: silentLogger(), now: () => 99 });
    try {
      assert.equal(recovered, true);
      assert.equal(backupPath, `${file}.corrupt-99`);
      // The damaged page belongs to an index/another table: the downloads table itself is intact.
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get()?.['n'], 400);
      assert.deepEqual(salvage?.tables['downloads'], { copied: 400, skipped: 0, unreadable: false });
    } finally {
      db.close();
    }
  });

  it('refuses a database written by a newer build without changing it', () => {
    const file = path.join(dir, DATABASE_FILE_NAME);
    const { db: created } = openSqliteDatabase({ file, logger: silentLogger(), now: () => 1 });
    created.exec('INSERT INTO schema_migrations (version, applied_at) VALUES (5, 2)');
    created.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    created.close();
    const before = readFileSync(file);
    const { logger, entries } = captureLogger();
    assert.throws(
      () => openSqliteDatabase({ file, logger, now: () => 3 }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === ErrorCode.DATABASE_TOO_NEW &&
        error.params?.['version'] === 5 &&
        error.params['known'] === 1
    );
    assert.ok(readFileSync(file).equals(before), 'nothing written');
    assert.ok(!readdirSync(dir).some((name) => name.includes('.corrupt-')), 'not treated as corruption');
    assert.ok(entries.some((entry) => entry.level === 'error'));
  });

  it('does not overwrite an earlier backup with the same timestamp', () => {
    const file = path.join(dir, DATABASE_FILE_NAME);
    writeFileSync(`${file}.corrupt-7`, 'older backup');
    writeFileSync(file, 'garbage '.repeat(600));
    const { db, backupPath } = openSqliteDatabase({ file, logger: silentLogger(), now: () => 7 });
    db.close();
    assert.equal(backupPath, `${file}.corrupt-7-1`);
    assert.equal(readFileSync(`${file}.corrupt-7`, 'utf8'), 'older backup');
  });

  it('recovers through the persistence factory and reports it', () => {
    writeFileSync(path.join(dir, DATABASE_FILE_NAME), Buffer.alloc(8192, 0x41));
    const persistence = openTestPersistence(dir);
    try {
      assert.equal(persistence.recovered, true);
      assert.equal(persistence.salvage?.opened, false);
      assert.ok(persistence.backupPath?.includes('.corrupt-'));
      assert.deepEqual(persistence.context.conversations.list(10, null), { items: [], nextCursor: null });
      assert.ok(readdirSync(dir).some((name) => name.startsWith(`${DATABASE_FILE_NAME}.corrupt-`)));
    } finally {
      persistence.context.close();
    }
  });

  it('classifies sqlite corruption errors', () => {
    assert.equal(isCorruptionError({ errcode: 26 }), true);
    assert.equal(isCorruptionError({ errcode: 11 | (1 << 8) }), true);
    assert.equal(isCorruptionError({ errcode: 5 }), false);
    assert.equal(isCorruptionError(new Error('database disk image is malformed')), true);
    assert.equal(isCorruptionError(new Error('database is locked')), false);
  });
});
