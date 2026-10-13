import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_HOST_SETTINGS, type HostSettings } from '../../application/ports/persistence.ts';
import type { SqlitePersistence } from './sqlite-persistence.ts';
import { DATABASE_FILE_NAME } from './sqlite-database.ts';
import {
  batchRecord,
  captureLogger,
  downloadRecord,
  makeTempDir,
  mediaFile,
  openTestPersistence
} from './test-fixtures.ts';

describe('sqlite repositories', () => {
  let dir: string;
  let cleanup: () => void;
  let persistence: SqlitePersistence;
  let logs: ReturnType<typeof captureLogger>;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    logs = captureLogger();
    persistence = openTestPersistence(dir, 'linux', logs.logger);
  });
  afterEach(() => {
    persistence.context.close();
    cleanup();
  });

  it('round-trips a download record with every field', () => {
    const { downloads, batches } = persistence.context;
    batches.save(batchRecord());
    const record = downloadRecord({
      batchId: 'b1',
      status: 'running',
      outcome: null,
      legacySummary: 'legacy text',
      cookieName: 'x.com.txt',
      process: {
        pid: 4242,
        imageName: 'yt-dlp',
        startToken: '12345',
        startTokenSource: 'proc',
        executable: '/opt/yt-dlp',
        capturedAt: 77
      },
      logFile: '/data/jobs/d1.log',
      logOffset: 512,
      retry: { browserCookieMode: 'skip', skipTried: true, forceTried: false },
      usedBrowserCookies: true,
      lastErrorKind: 'cookies-auth',
      errorLines: ['ERROR: \u001b[0;31mbad\u001b[0m', 'second']
    });
    downloads.save(record);
    assert.deepEqual(downloads.get('d1'), record);
    assert.equal(downloads.get('missing'), null);
  });

  it('upserts, lists active in position order and computes positions', () => {
    const { downloads } = persistence.context;
    assert.equal(downloads.nextPosition(), 0);
    downloads.save(downloadRecord({ id: 'a', status: 'paused', position: 5 }));
    downloads.save(downloadRecord({ id: 'b', status: 'pending', position: 2 }));
    downloads.save(downloadRecord({ id: 'c', status: 'completed', position: 1 }));
    downloads.save(downloadRecord({ id: 'd', status: 'running', position: 9 }));
    assert.deepEqual(
      downloads.listActive().map((r) => r.id),
      ['b', 'a', 'd']
    );
    assert.equal(downloads.nextPosition(), 10);
    downloads.save(downloadRecord({ id: 'b', status: 'failed', position: 2 }));
    assert.deepEqual(
      downloads.listActive().map((r) => r.id),
      ['a', 'd']
    );
    downloads.delete('a');
    assert.equal(downloads.get('a'), null);
  });

  it('keeps folder assignments when a stale record is saved again', () => {
    const { downloads, folders } = persistence.context;
    folders.save({ id: 'f1', name: 'Art', color: '#112233', collapsed: false, position: 0, createdAt: 1 });
    const stale = downloadRecord({ id: 'x', status: 'running' });
    downloads.save(stale);
    assert.equal(folders.assign(['x'], 'f1'), 1);
    downloads.save({ ...stale, counters: { done: 5, skipped: 0, errors: 0 } });
    assert.equal(downloads.get('x')?.folderId, 'f1');
    assert.equal(downloads.get('x')?.counters.done, 5);
  });

  it('returns recent distinct source urls and downloads by batch', () => {
    const { downloads, batches } = persistence.context;
    batches.save(batchRecord({ id: 'b1' }));
    downloads.save(
      downloadRecord({ id: '1', sourceUrl: 'https://a.test/1', createdAt: 10, batchId: 'b1', position: 2 })
    );
    downloads.save(
      downloadRecord({ id: '2', sourceUrl: 'https://b.test/2', createdAt: 20, batchId: 'b1', position: 1 })
    );
    downloads.save(downloadRecord({ id: '3', sourceUrl: 'https://a.test/1', createdAt: 30 }));
    assert.deepEqual(downloads.recentSourceUrls(10), ['https://a.test/1', 'https://b.test/2']);
    assert.deepEqual(downloads.recentSourceUrls(1), ['https://a.test/1']);
    assert.deepEqual(downloads.recentSourceUrls(0), []);
    assert.deepEqual(
      downloads.listByBatch('b1').map((r) => r.id),
      ['2', '1']
    );
  });

  it('round-trips batches', () => {
    const { batches } = persistence.context;
    batches.save(batchRecord());
    batches.save(batchRecord({ notifiedAt: 99, total: 3 }));
    assert.deepEqual(batches.get('b1'), batchRecord({ notifiedAt: 99, total: 3 }));
    assert.equal(batches.get('zz'), null);
  });

  it('skips and logs corrupted rows instead of throwing', () => {
    const { downloads } = persistence.context;
    downloads.save(downloadRecord({ id: 'good', status: 'paused' }));
    downloads.save(downloadRecord({ id: 'bad', status: 'paused', position: 1 }));
    persistence.context.close();
    const raw = new DatabaseSync(path.join(dir, DATABASE_FILE_NAME));
    raw.prepare(`UPDATE downloads SET counters = '{"done":-1}' WHERE id = 'bad'`).run();
    raw.close();
    persistence = openTestPersistence(dir, 'linux', logs.logger);
    assert.deepEqual(
      persistence.context.downloads.listActive().map((r) => r.id),
      ['good']
    );
    assert.equal(persistence.context.downloads.get('bad'), null);
    assert.equal(persistence.context.conversations.get('bad'), null);
    assert.deepEqual(
      persistence.context.conversations.list(10, null).items.map((r) => r.id),
      ['good']
    );
    assert.ok(logs.entries.some((e) => e.level === 'warn' && e.fields?.['id'] === 'bad'));
  });

  it('cascades files and events when a download is deleted', () => {
    const { downloads, files, events, conversations } = persistence.context;
    downloads.save(downloadRecord());
    files.add(mediaFile());
    events.append({ conversationId: 'd1', type: 'created', level: 'info', code: 'created', params: {}, createdAt: 1 });
    downloads.delete('d1');
    assert.equal(files.countByConversation('d1'), 0);
    assert.deepEqual(conversations.recentEvents('d1', 10), []);
  });

  it('appends events and returns the newest ones oldest first', () => {
    const { downloads, events, conversations } = persistence.context;
    downloads.save(downloadRecord());
    for (let i = 0; i < 310; i += 1) {
      events.append({
        conversationId: 'd1',
        type: 'retry',
        level: 'warning',
        code: 'retryWithoutCookies',
        params: { attempt: i, ok: true, note: null, text: 'x' },
        createdAt: 1_000 + i
      });
    }
    const recent = conversations.recentEvents('d1', 3);
    assert.deepEqual(
      recent.map((e) => e.params['attempt']),
      [307, 308, 309]
    );
    assert.equal(recent[0]?.legacyMessage, null);
    const detail = conversations.get('d1');
    assert.equal(detail?.events.length, 300);
    assert.equal(detail?.events[0]?.params['attempt'], 10);
    assert.equal(detail?.events.at(-1)?.params['attempt'], 309);
    events.appendLegacy({
      conversationId: 'd1',
      type: 'legacy',
      level: 'info',
      code: 'legacy',
      params: {},
      legacyMessage: 'Download concluído.',
      createdAt: 5_000
    });
    assert.equal(conversations.recentEvents('d1', 1)[0]?.legacyMessage, 'Download concluído.');
    events.deleteByConversation('d1');
    assert.deepEqual(conversations.recentEvents('d1', 5), []);
  });

  it('manages folders, assignment and unassignment', () => {
    const { downloads, folders } = persistence.context;
    assert.equal(folders.nextPosition(), 0);
    folders.save({ id: 'f2', name: 'B', color: '#000000', collapsed: true, position: 1, createdAt: 2 });
    folders.save({ id: 'f1', name: 'A', color: '#ffffff', collapsed: false, position: 0, createdAt: 1 });
    assert.deepEqual(
      folders.list().map((f) => f.id),
      ['f1', 'f2']
    );
    assert.equal(folders.get('f2')?.collapsed, true);
    assert.equal(folders.nextPosition(), 2);
    downloads.save(downloadRecord({ id: 'a' }));
    downloads.save(downloadRecord({ id: 'b' }));
    assert.equal(folders.assign(['a', 'b', 'missing'], 'f1'), 2);
    assert.equal(folders.assign(['a'], 'f1'), 0, 'unchanged rows are not counted');
    assert.equal(folders.assign(['a'], 'nope'), 0, 'unknown folder assigns nothing');
    assert.equal(downloads.get('a')?.folderId, 'f1');
    assert.equal(folders.assign(['b'], null), 1);
    folders.unassignAll('f1');
    assert.equal(downloads.get('a')?.folderId, null);
    folders.assign(['a'], 'f2');
    folders.delete('f2');
    assert.equal(folders.get('f2'), null);
    assert.equal(downloads.get('a')?.folderId, null);
  });

  it('loads default host settings and round-trips saved ones', () => {
    const { settings } = persistence.context;
    assert.deepEqual(settings.load(), DEFAULT_HOST_SETTINGS);
    const next: HostSettings = {
      downloadDir: '/home/u/Downloads/Yami',
      defaultEngine: 'yt-dlp',
      runtimeMode: 'python',
      setupDismissed: true,
      cookies: {
        active: 'x.com.txt',
        fromBrowser: true,
        bindings: [{ id: 'cb1', siteHost: 'x.com', cookieName: 'x.com.txt' }]
      },
      toolUpdates: { checkedAt: 123, latest: { 'yt-dlp': '2026.09.01' } }
    };
    settings.save(next);
    assert.deepEqual(settings.load(), next);
  });

  it('merges invalid stored settings field by field over the defaults', () => {
    persistence.context.close();
    const raw = new DatabaseSync(path.join(dir, DATABASE_FILE_NAME));
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'host',
      JSON.stringify({
        downloadDir: 42,
        defaultEngine: 'yt-dlp',
        runtimeMode: 'weird',
        setupDismissed: true,
        cookies: {
          active: '../escape',
          fromBrowser: 'yes',
          bindings: [
            { id: 'ok', siteHost: 'x.com', cookieName: 'x.txt' },
            { id: 'bad id', siteHost: '', cookieName: 1 }
          ]
        },
        toolUpdates: { checkedAt: -5, latest: { 'yt-dlp': ' 1.0 ', bogus: '2', deno: 3 } },
        extra: true
      })
    );
    raw.close();
    persistence = openTestPersistence(dir);
    assert.deepEqual(persistence.context.settings.load(), {
      downloadDir: null,
      defaultEngine: 'yt-dlp',
      runtimeMode: 'standalone',
      setupDismissed: true,
      cookies: { active: null, fromBrowser: false, bindings: [{ id: 'ok', siteHost: 'x.com', cookieName: 'x.txt' }] },
      toolUpdates: { checkedAt: null, latest: { 'yt-dlp': '1.0' } }
    });
  });

  it('stores internal markers separately from settings', () => {
    const { markers, settings } = persistence.context;
    assert.equal(markers.get('legacyImport'), null);
    markers.set('legacyImport', 1234);
    assert.equal(markers.get('legacyImport'), 1234);
    assert.deepEqual(settings.load(), DEFAULT_HOST_SETTINGS);
    markers.delete('legacyImport');
    assert.equal(markers.get('legacyImport'), null);
  });
});
