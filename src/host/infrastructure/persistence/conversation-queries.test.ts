import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { conversationPageSql } from './conversation-queries.ts';
import type { SqlitePersistence } from './sqlite-persistence.ts';
import { DATABASE_FILE_NAME } from './sqlite-database.ts';
import { downloadRecord, makeTempDir, mediaFile, openTestPersistence } from './test-fixtures.ts';

function collectAll(persistence: SqlitePersistence, pageSize: number): string[] {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = persistence.context.conversations.list(pageSize, cursor);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

describe('SqliteConversationQueries', () => {
  let cleanup: () => void;
  let persistence: SqlitePersistence;

  beforeEach(() => {
    let dir: string;
    ({ dir, cleanup } = makeTempDir());
    persistence = openTestPersistence(dir);
  });
  afterEach(() => {
    persistence.context.close();
    cleanup();
  });

  it('pages newest first with stable ordering on updatedAt ties', () => {
    const { downloads } = persistence.context;
    const ts = 1_700_000_000_000;
    downloads.save(downloadRecord({ id: 'conv-b', updatedAt: ts }));
    downloads.save(downloadRecord({ id: 'conv-a', updatedAt: ts }));
    downloads.save(downloadRecord({ id: 'conv-c', updatedAt: ts }));
    downloads.save(downloadRecord({ id: 'conv-z', updatedAt: ts - 1 }));
    downloads.save(downloadRecord({ id: 'conv-new', updatedAt: ts + 1 }));
    const expected = ['conv-new', 'conv-c', 'conv-b', 'conv-a', 'conv-z'];
    for (const size of [1, 2, 3, 5, 10]) assert.deepEqual(collectAll(persistence, size), expected, `size ${size}`);
    const first = persistence.context.conversations.list(2, null);
    assert.equal(typeof first.nextCursor, 'string');
    assert.deepEqual(persistence.context.conversations.list(2, 'garbage'), { items: [], nextCursor: null });
    assert.equal(persistence.context.conversations.list(5, null).nextCursor, null);
  });

  it('does not duplicate or skip rows when new conversations arrive while paging', () => {
    const { downloads } = persistence.context;
    for (let i = 0; i < 9; i += 1) downloads.save(downloadRecord({ id: `c${i}`, updatedAt: 100 + i }));
    const page1 = persistence.context.conversations.list(4, null);
    downloads.save(downloadRecord({ id: 'fresh', updatedAt: 999 }));
    const page2 = persistence.context.conversations.list(4, page1.nextCursor);
    const page3 = persistence.context.conversations.list(4, page2.nextCursor);
    const ids = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
    assert.deepEqual(ids, ['c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0']);
    assert.equal(page3.nextCursor, null);
  });

  it('computes cover, primary media type and total bytes', () => {
    const { downloads, files, conversations } = persistence.context;
    downloads.save(downloadRecord({ id: 'd1', folderId: null, legacySummary: 'old' }));
    downloads.save(downloadRecord({ id: 'empty', updatedAt: 1 }));
    files.add(mediaFile({ path: '/dl/v1.mp4', mediaType: 'video', extension: '.mp4', sizeBytes: 1_000, createdAt: 5 }));
    files.add(mediaFile({ path: '/dl/i1.jpg', createdAt: 3, sizeBytes: 10 }));
    files.add(mediaFile({ path: '/dl/i2.jpg', createdAt: 7, sizeBytes: null }));
    files.add(mediaFile({ path: '/dl/i3.jpg', createdAt: 8, sizeBytes: 5 }));
    const [summary, empty] = conversations.list(10, null).items;
    assert.equal(summary?.id, 'd1');
    assert.equal(summary?.coverPath, '/dl/i1.jpg');
    assert.equal(summary?.primaryMediaType, 'image');
    assert.equal(summary?.totalBytes, 1_015);
    assert.equal(summary?.legacySummary, 'old');
    assert.equal(empty?.coverPath, null);
    assert.equal(empty?.primaryMediaType, null);
    assert.equal(empty?.totalBytes, 0);
    const detail = conversations.get('d1');
    assert.equal(detail?.filesCount, 4);
    assert.equal(detail?.coverPath, '/dl/i1.jpg');
    assert.deepEqual(detail?.events, []);
    assert.equal(conversations.get('nope'), null);
  });
});

describe('SqliteConversationQueries at scale (10k conversations, 200k files)', () => {
  let cleanup: () => void;
  let dir: string;
  let persistence: SqlitePersistence;

  before(() => {
    ({ dir, cleanup } = makeTempDir());
    openTestPersistence(dir).context.close();
    const raw = new DatabaseSync(path.join(dir, DATABASE_FILE_NAME));
    raw.exec(`
      BEGIN;
      WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 9999)
      INSERT INTO downloads (id, source_url, title, engine, scope, status, counters, position, created_at,
        updated_at, retry)
      SELECT printf('c%05d', n), 'https://example.com/' || n, 'title ' || n, 'gallery-dl', 'bulk', 'completed',
        '{"done":20,"skipped":0,"errors":0}', n, n, 1000000 + (n / 3),
        '{"browserCookieMode":null,"skipTried":false,"forceTried":false}'
      FROM seq;
      WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 199999)
      INSERT INTO media_files (conversation_id, path, name, media_type, extension, size_bytes, created_at)
      SELECT printf('c%05d', n / 20), '/dl/' || (n / 20) || '/' || n || '.jpg', n || '.jpg',
        CASE WHEN n % 20 < 12 THEN 'image' ELSE 'video' END, '.jpg', n % 1000, n
      FROM seq;
      COMMIT;
      ANALYZE;
    `);
    raw.close();
    persistence = openTestPersistence(dir);
  });
  after(() => {
    persistence.context.close();
    cleanup();
  });

  it('uses indexes for the page and its aggregates (no full scans of media_files)', () => {
    const raw = new DatabaseSync(path.join(dir, DATABASE_FILE_NAME));
    try {
      const first = persistence.context.conversations.list(2, null);
      assert.ok(first.nextCursor);
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${conversationPageSql(true)}`)
        .all(1_000_100, 'c00300', 50)
        .map((row) => String(row['detail']));
      assert.ok(!plan.some((detail) => /^SCAN (f|media_files)\b/.test(detail)), plan.join('\n'));
      assert.ok(
        plan.some((detail) => detail.includes('idx_downloads_updated')),
        plan.join('\n')
      );
    } finally {
      raw.close();
    }
  });

  it('lists every conversation through the cursor quickly and with correct aggregates', () => {
    const started = performance.now();
    const ids = collectAll(persistence, 500);
    const elapsed = performance.now() - started;
    assert.equal(ids.length, 10_000);
    assert.equal(new Set(ids).size, 10_000);
    assert.equal(ids[0], 'c09999');
    assert.equal(ids.at(-1), 'c00000');
    // 20 pages over 200k files; generous bound to stay stable on slow CI machines.
    assert.ok(elapsed < 3_000, `listing took ${elapsed.toFixed(0)} ms`);

    const page = persistence.context.conversations.list(1, null).items[0];
    assert.equal(page?.coverPath, '/dl/9999/199980.jpg');
    assert.equal(page?.primaryMediaType, 'image');
    let expectedBytes = 0;
    for (let n = 199_980; n < 200_000; n += 1) expectedBytes += n % 1000;
    assert.equal(page?.totalBytes, expectedBytes);
  });

  it('serves a single page in a few milliseconds', () => {
    const cursor = persistence.context.conversations.list(5_000, null).nextCursor;
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) persistence.context.conversations.list(100, cursor);
    const perPage = (performance.now() - started) / 10;
    assert.ok(perPage < 100, `page took ${perPage.toFixed(1)} ms`);
  });

  it('renames a directory among 200k rows in one transaction', () => {
    const started = performance.now();
    assert.equal(persistence.context.files.renameDirectory('/dl/123', '/dl/renamed', false), 20);
    assert.ok(performance.now() - started < 2_000);
    assert.equal(persistence.context.files.pathsByConversation('c00123')[0], '/dl/renamed/2460.jpg');
    assert.equal(persistence.context.files.pathsByConversation('c01234')[0], '/dl/1234/24680.jpg');
  });
});
