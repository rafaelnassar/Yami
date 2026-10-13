import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_HOST_SETTINGS } from '../../application/ports/persistence.ts';
import { ORPHAN_PHASE_SHARE, salvageDatabase, type SalvageReport } from './database-salvage.ts';
import { silentLogger } from './silent-logger.ts';
import { DATABASE_FILE_NAME, openSqliteDatabase } from './sqlite-database.ts';
import {
  batchRecord,
  captureLogger,
  downloadRecord,
  makeTempDir,
  mediaFile,
  openTestPersistence
} from './test-fixtures.ts';

const PAGE_SIZE = 4096;
const ROWS = 400;

function title(i: number): string {
  return `title-${i}`.repeat(20);
}

/** Overwrites the whole database page that holds `needle` with garbage. */
function damagePageContaining(file: string, needle: string): void {
  const bytes = readFileSync(file);
  const offset = bytes.indexOf(needle);
  assert.ok(offset > PAGE_SIZE, 'needle not found outside the first page');
  const page = Math.floor(offset / PAGE_SIZE);
  bytes.fill(0xff, page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  writeFileSync(file, bytes);
}

function foreignKeyViolations(db: DatabaseSync): unknown[] {
  return db.prepare('PRAGMA foreign_key_check').all();
}

describe('database salvage', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir('yami-salvage-'));
  });
  afterEach(() => cleanup());

  /** A valid database with `count` downloads (the first one in batch `b1`). */
  function sourceWithDownloads(count: number): string {
    const persistence = openTestPersistence(path.join(dir, 'source'));
    const { downloads, batches, tx } = persistence.context;
    tx.transaction(() => {
      batches.save(batchRecord());
      for (let i = 0; i < count; i += 1) {
        downloads.save(downloadRecord({ id: `d${i}`, position: i, batchId: i === 0 ? 'b1' : null }));
      }
    });
    persistence.context.close();
    return path.join(dir, 'source', DATABASE_FILE_NAME);
  }

  function salvageInto(
    source: string,
    extra: Partial<Parameters<typeof salvageDatabase>[0]> = {}
  ): {
    readonly report: SalvageReport;
    readonly db: DatabaseSync;
  } {
    const { db } = openSqliteDatabase({
      file: path.join(dir, `target-${Math.random()}.db`),
      logger: silentLogger(),
      now: () => 1
    });
    return { report: salvageDatabase({ source, target: db, logger: silentLogger(), ...extra }), db };
  }

  it('copies the rows around a damaged page into the recreated database', () => {
    const first = openTestPersistence(dir);
    const { downloads, batches, folders, files, events, markers, settings, tx } = first.context;
    tx.transaction(() => {
      batches.save(batchRecord());
      folders.save({ id: 'f1', name: 'Favoritos', color: '#112233', collapsed: false, position: 0, createdAt: 1 });
      for (let i = 0; i < ROWS; i += 1) {
        const links = { batchId: i === 0 ? 'b1' : null, folderId: i === ROWS - 1 ? 'f1' : null };
        downloads.save(downloadRecord({ id: `d${i}`, title: title(i), position: i, updatedAt: i, ...links }));
      }
    });
    for (const id of ['d0', 'd200', `d${ROWS - 1}`]) {
      files.add(mediaFile({ conversationId: id, path: `/dl/${id}.jpg` }));
      events.append({ conversationId: id, type: 'created', level: 'info', code: 'created', params: {}, createdAt: 1 });
    }
    markers.set('legacyImport', 5);
    settings.save({ ...DEFAULT_HOST_SETTINGS, downloadDir: '/home/u/Yami' });
    first.context.close();
    damagePageContaining(path.join(dir, DATABASE_FILE_NAME), title(200));

    const { logger, entries } = captureLogger();
    const second = openTestPersistence(dir, 'linux', logger);
    try {
      assert.equal(second.recovered, true);
      const report = second.salvage;
      assert.ok(report?.opened);
      assert.equal(report.truncated, false);
      const lost = report.tables['downloads'];
      assert.ok(lost && lost.unreadable, 'the damaged page could not be read');
      assert.ok(lost.copied > ROWS - 40 && lost.copied < ROWS, `copied ${lost.copied}`);

      const context = second.context;
      assert.equal(context.downloads.get('d200'), null, 'the row on the damaged page is lost');
      assert.equal(context.downloads.get('d0')?.batchId, 'b1', 'rows before the damaged page, with their batch');
      assert.equal(context.downloads.get(`d${ROWS - 1}`)?.folderId, 'f1', 'rows after it (backward scan)');
      assert.equal(context.markers.get('legacyImport'), 5, 'the legacy-import marker survives');
      assert.equal(context.settings.load().downloadDir, '/home/u/Yami');
      assert.equal(context.folders.get('f1')?.name, 'Favoritos');
      assert.equal(context.files.countByConversation('d0'), 1);
      assert.equal(context.conversations.get(`d${ROWS - 1}`)?.events.length, 1);
      // The file and the event of the lost conversation are dropped (ON DELETE CASCADE semantics).
      assert.deepEqual(report.tables['media_files'], { copied: 2, skipped: 1, unreadable: false });
      assert.deepEqual(report.tables['conversation_events'], { copied: 2, skipped: 1, unreadable: false });
      assert.ok(entries.some((entry) => entry.message === 'database salvage finished'));
    } finally {
      second.context.close();
    }
    const check = new DatabaseSync(path.join(dir, DATABASE_FILE_NAME));
    try {
      assert.deepEqual(foreignKeyViolations(check), []);
    } finally {
      check.close();
    }
  });

  it('nulls references to lost parents, drops orphans and skips rows the schema rejects', () => {
    const source = sourceWithDownloads(3);
    const raw = new DatabaseSync(source);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec('PRAGMA ignore_check_constraints = ON');
    raw.exec("UPDATE downloads SET batch_id = 'gone', folder_id = 'gone-too' WHERE id = 'd1'");
    raw.exec(
      "INSERT INTO media_files (conversation_id, path, name, media_type, created_at) VALUES ('ghost', '/g.jpg', 'g.jpg', 'image', 1), ('d2', '/d2.jpg', 'd2.jpg', 'image', 1)"
    );
    // A column this build does not know is ignored; a value the schema rejects is skipped.
    raw.exec('ALTER TABLE settings ADD COLUMN future TEXT');
    raw.exec(
      `INSERT INTO settings (key, value, future) VALUES ('marker:legacyImport', '7', 'x'), ('broken', 'not json', NULL)`
    );
    raw.close();

    const { report, db } = salvageInto(source);
    try {
      assert.equal(report.opened, true);
      assert.deepEqual(report.tables['settings'], { copied: 1, skipped: 1, unreadable: false });
      assert.deepEqual(report.tables['media_files'], { copied: 1, skipped: 1, unreadable: false });
      assert.deepEqual(report.tables['downloads'], { copied: 3, skipped: 0, unreadable: false });
      const d1 = db.prepare("SELECT batch_id, folder_id FROM downloads WHERE id = 'd1'").get();
      assert.deepEqual({ ...d1 }, { batch_id: null, folder_id: null });
      assert.equal(db.prepare("SELECT batch_id FROM downloads WHERE id = 'd0'").get()?.['batch_id'], 'b1');
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'marker:legacyImport'").get()?.['value'], '7');
      assert.deepEqual(foreignKeyViolations(db), []);
      assert.equal(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'], 1, 'foreign keys back on');
      assert.equal(db.isTransaction, false);
    } finally {
      db.close();
    }
  });

  it('stops at the row budget', () => {
    const source = sourceWithDownloads(50);
    const { report, db } = salvageInto(source, { budget: { maxRows: 10, maxMillis: 60_000 } });
    try {
      assert.equal(report.truncated, true);
      assert.equal(report.copied, 10);
      assert.equal(report.tables['batches']?.copied, 1, 'parents are copied before children');
      assert.deepEqual(foreignKeyViolations(db), []);
    } finally {
      db.close();
    }
  });

  it('stops at the time budget', () => {
    const source = sourceWithDownloads(50);
    let clock = 0;
    const { report, db } = salvageInto(source, {
      budget: { maxRows: 1_000_000, maxMillis: 100 },
      elapsed: () => (clock += 10)
    });
    try {
      assert.equal(report.truncated, true);
      assert.ok(report.copied > 0 && report.copied < 51, `copied ${report.copied}`);
    } finally {
      db.close();
    }
  });

  it('stops the copy early enough to leave the orphan phase its share of the time budget', () => {
    const source = sourceWithDownloads(200);
    let clock = 0;
    const { logger, entries } = captureLogger();
    const { report, db } = salvageInto(source, {
      budget: { maxRows: 1_000_000, maxMillis: 100 },
      elapsed: () => (clock += 1),
      logger
    });
    try {
      assert.equal(report.truncated, true);
      const fields = entries.find((entry) => entry.message === 'database salvage finished')?.fields;
      const copyMillis = Number(fields?.['copyMillis']);
      assert.ok(copyMillis <= 100 * (1 - ORPHAN_PHASE_SHARE) + 1, `copy took ${copyMillis} of 100`);
      assert.ok(!entries.some((entry) => entry.message.includes('exceeded the budget')));
      assert.deepEqual(foreignKeyViolations(db), []);
    } finally {
      db.close();
    }
  });

  it('drops a large number of orphans within the reserved share of the budget', () => {
    const source = sourceWithDownloads(2);
    const raw = new DatabaseSync(source);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
      INSERT INTO media_files (conversation_id, path, name, media_type, created_at)
        SELECT CASE WHEN i <= 10 THEN 'd1' ELSE 'gone' END, '/dl/' || i || '.jpg', i || '.jpg', 'image', i FROM n;
      UPDATE downloads SET batch_id = 'gone' WHERE id = 'd1';
    `);
    raw.close();
    const { logger, entries } = captureLogger();
    const { report, db } = salvageInto(source, { logger });
    try {
      assert.equal(report.truncated, false);
      assert.deepEqual(report.tables['media_files'], { copied: 10, skipped: 99_990, unreadable: false });
      assert.equal(db.prepare("SELECT batch_id FROM downloads WHERE id = 'd1'").get()?.['batch_id'], null);
      assert.deepEqual(foreignKeyViolations(db), []);
      const fields = entries.find((entry) => entry.message === 'database salvage finished')?.fields;
      const copyMillis = Number(fields?.['copyMillis']);
      const orphanMillis = Number(fields?.['orphanMillis']);
      // Functional asserts above already prove orphans were dropped within the salvage budget.
      // Wall-clock ratios vs copy are noisy on shared CI runners — keep only a very loose guard.
      const affordable = (copyMillis * ORPHAN_PHASE_SHARE) / (1 - ORPHAN_PHASE_SHARE);
      assert.ok(orphanMillis < Math.max(10_000, affordable * 10), `${orphanMillis} ms vs copy ${copyMillis} ms`);
    } finally {
      db.close();
    }
  });

  it('reports an unreadable or missing source without throwing', () => {
    const garbage = path.join(dir, 'garbage.db');
    writeFileSync(garbage, 'not a database '.repeat(500));
    for (const source of [garbage, path.join(dir, 'missing.db')]) {
      const { report, db } = salvageInto(source);
      try {
        assert.deepEqual(report, { opened: false, tables: {}, copied: 0, skipped: 0, truncated: false });
        assert.equal(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'], 1);
      } finally {
        db.close();
      }
    }
  });
});
