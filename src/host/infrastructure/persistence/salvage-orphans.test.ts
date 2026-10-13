import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { resolveOrphans, type OrphanCounters } from './salvage-orphans.ts';

/** Schema exercising cascades, SET NULL on a NOT NULL column, composite and implicit-PK keys. */
const SCHEMA = `
CREATE TABLE grand (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE "parent ""p""" (
  id TEXT PRIMARY KEY,
  grand_id TEXT NOT NULL REFERENCES grand(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  parent_id TEXT REFERENCES "parent ""p"""(id) ON DELETE CASCADE,
  optional_grand TEXT REFERENCES grand ON DELETE SET NULL,
  required_grand TEXT NOT NULL REFERENCES grand(id) ON DELETE SET NULL
) STRICT;
CREATE TABLE pair (a TEXT, b TEXT, PRIMARY KEY (a, b)) STRICT;
CREATE TABLE pair_ref (id INTEGER PRIMARY KEY, a TEXT, b TEXT, FOREIGN KEY (a, b) REFERENCES pair(a, b)) STRICT;
`;

/** As during the salvage: rows are inserted with foreign keys off. */
function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SCHEMA);
  return db;
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n']);
}

describe('resolveOrphans', () => {
  it('applies ON DELETE semantics per key, following cascades in one pass', () => {
    const db = openDatabase();
    db.exec(`
      INSERT INTO grand VALUES ('g1');
      INSERT INTO "parent ""p""" VALUES ('p1', 'g1'), ('p-orphan', 'g-gone');
      INSERT INTO child (id, parent_id, optional_grand, required_grand) VALUES
        (1, 'p1', 'g1', 'g1'),
        (2, 'p-orphan', 'g1', 'g1'),
        (3, 'p1', 'g-gone', 'g1'),
        (4, 'p1', 'g1', 'g-gone'),
        (5, NULL, NULL, 'g1');
      INSERT INTO pair VALUES ('x', 'y');
      INSERT INTO pair_ref (id, a, b) VALUES (1, 'x', 'y'), (2, 'x', 'z'), (3, 'x', NULL);
    `);
    const counters = new Map<string, OrphanCounters>([
      ['parent "p"', { copied: 2, skipped: 0 }],
      ['child', { copied: 5, skipped: 0 }],
      ['pair_ref', { copied: 3, skipped: 0 }]
    ]);
    resolveOrphans(db, counters);

    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.isTransaction, false);
    // p-orphan dropped (CASCADE), and with it child 2; child 4 dropped because NOT NULL rejects SET NULL.
    assert.deepEqual(
      db
        .prepare('SELECT id, parent_id, optional_grand FROM child ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 1, parent_id: 'p1', optional_grand: 'g1' },
        { id: 3, parent_id: 'p1', optional_grand: null },
        { id: 5, parent_id: null, optional_grand: null }
      ]
    );
    assert.equal(count(db, '"parent ""p"""'), 1);
    // Composite key: a NULL member is never a violation (MATCH SIMPLE).
    assert.deepEqual(
      db
        .prepare('SELECT id FROM pair_ref ORDER BY id')
        .all()
        .map((row) => row['id']),
      [1, 3]
    );
    assert.deepEqual(counters.get('parent "p"'), { copied: 1, skipped: 1 });
    assert.deepEqual(counters.get('child'), { copied: 3, skipped: 2 });
    assert.deepEqual(counters.get('pair_ref'), { copied: 2, skipped: 1 });
    db.close();
  });

  it('resolves a large number of orphans quickly with set-based statements', () => {
    const db = openDatabase();
    db.exec(`
      INSERT INTO grand VALUES ('g1');
      INSERT INTO "parent ""p""" VALUES ('p1', 'g1');
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000)
      INSERT INTO child (id, parent_id, optional_grand, required_grand)
        SELECT i, CASE WHEN i % 2 = 0 THEN 'p1' ELSE 'p-gone' END, 'g1', 'g1' FROM n;
    `);
    const counters = new Map<string, OrphanCounters>([['child', { copied: 200_000, skipped: 0 }]]);
    const started = performance.now();
    resolveOrphans(db, counters);
    const millis = performance.now() - started;
    assert.deepEqual(counters.get('child'), { copied: 100_000, skipped: 100_000 });
    assert.equal(count(db, 'child'), 100_000);
    // The per-row approach needed seconds here; one DELETE takes a fraction of that.
    assert.ok(millis < 2_000, `took ${Math.round(millis)} ms`);
    db.close();
  });

  it('leaves a consistent database untouched', () => {
    const db = openDatabase();
    db.exec(`INSERT INTO grand VALUES ('g1'); INSERT INTO "parent ""p""" VALUES ('p1', 'g1');`);
    const counters = new Map<string, OrphanCounters>([['parent "p"', { copied: 1, skipped: 0 }]]);
    resolveOrphans(db, counters);
    assert.deepEqual(counters.get('parent "p"'), { copied: 1, skipped: 0 });
    assert.equal(count(db, '"parent ""p"""'), 1);
    db.close();
  });
});
