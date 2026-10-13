import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { err, ok } from '../../../shared/kernel/result.ts';
import type { CookieVault } from '../../application/ports/secrets.ts';
import { DEFAULT_HOST_SETTINGS } from '../../application/ports/persistence.ts';
import type { SqlitePersistence } from '../persistence/sqlite-persistence.ts';
import { captureLogger, makeTempDir, openTestPersistence } from '../persistence/test-fixtures.ts';
import { EncryptedCookieVault } from '../security/encrypted-cookie-vault.ts';
import { EncryptedCredentialVault } from '../security/encrypted-credential-vault.ts';
import { testBox } from '../security/test-fixtures.ts';
import { LEGACY_IMPORT_MARKER, LegacyImporter, type LegacyImporterOptions } from './legacy-importer.ts';
import { LEGACY_COOKIES, buildLegacyDir } from './test-fixtures.ts';

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else
        out[path.relative(dir, full).split(path.sep).join('/')] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex');
    }
  };
  walk(dir);
  return out;
}

describe('LegacyImporter', () => {
  let root: string;
  let cleanup: () => void;
  let legacyDir: string;
  let dataDir: string;
  let persistence: SqlitePersistence;
  let cookies: EncryptedCookieVault;
  let credentials: EncryptedCredentialVault;
  let now: number;

  function importer(overrides: Partial<LegacyImporterOptions> = {}): LegacyImporter {
    return new LegacyImporter({
      target: persistence.context,
      cookies,
      credentials,
      logger: captureLogger().logger,
      clock: { now: () => now },
      legacyDir,
      workDir: path.join(root, 'tmp'),
      ...overrides
    });
  }

  beforeEach(() => {
    ({ dir: root, cleanup } = makeTempDir('yami-legacy-test-'));
    legacyDir = buildLegacyDir(root);
    dataDir = path.join(root, 'data');
    persistence = openTestPersistence(dataDir);
    const box = testBox();
    cookies = new EncryptedCookieVault({ dataDir, box });
    credentials = new EncryptedCredentialVault({ dataDir, box });
    now = 9_000;
  });
  afterEach(() => {
    persistence.context.close();
    cleanup();
  });

  it('imports history, active jobs, cookies, credentials and settings, removing only the imported secrets', async () => {
    const before = snapshot(legacyDir);
    const report = await importer().run();
    const expected = { ...before };
    for (const secret of ['cookies/x.com.txt', 'cookies/reddit.cookies', 'credentials.json']) {
      assert.ok(expected[secret]);
      delete expected[secret];
    }
    // The invalid cookie file, the hidden file, the database (no -shm created either) and state.json are untouched.
    assert.deepEqual(snapshot(legacyDir), expected);
    assert.deepEqual(report, {
      status: 'imported',
      conversations: 4,
      pausedDownloads: 2,
      batches: 3,
      files: 2,
      events: 4,
      skipped: 2,
      cookies: { imported: 2, existing: 0, invalid: 1 },
      pixivImported: true,
      settingsImported: true,
      plaintextSecretsRemoved: 3,
      plaintextSecretsKept: 1,
      failedSteps: [],
      failedAttempts: 0
    });

    const { downloads, batches, conversations, files, settings, markers } = persistence.context;
    const done = downloads.get('c-done');
    assert.equal(done?.status, 'completed');
    assert.equal(done?.legacySummary, '2 baixado(s), 1 ignorado(s)');
    assert.equal(done?.outcome, null);
    assert.deepEqual(done?.counters, { done: 2, skipped: 1, errors: 0 });
    assert.equal(done?.batchId, 'b-old');
    assert.equal(done?.scope, 'bulk');
    assert.equal(done?.completedAt, 1_800);

    const running = downloads.get('c-run');
    assert.equal(running?.status, 'paused');
    assert.equal(running?.process, null);
    assert.equal(running?.completedAt, null);
    assert.equal(running?.title, 'abc');
    assert.equal(running?.cookieName, 'x.com.txt');
    assert.deepEqual(running?.counters, { done: 3, skipped: 1, errors: 0 }, 'state.json is fresher than the db');

    const pending = downloads.get('c-pend');
    assert.equal(pending?.status, 'paused');
    assert.equal(pending?.title, 'youtube.com');
    assert.equal(pending?.batchId, 'b-live');
    assert.equal(downloads.get('bad id!'), null);
    assert.equal(downloads.get('broken'), null);
    assert.deepEqual(
      downloads.listActive().map((r) => r.id),
      ['c-run', 'c-pend']
    );

    assert.equal(batches.get('b-old')?.notifiedAt, 1_900);
    assert.equal(batches.get('b-live')?.notifiedAt, null);
    assert.deepEqual(batches.get('b-state'), {
      id: 'b-state',
      engine: 'gallery-dl',
      scope: 'bulk',
      total: 1,
      createdAt: 4_000,
      notifiedAt: 4_500
    });

    const detail = conversations.get('c-done');
    assert.equal(detail?.filesCount, 2);
    assert.equal(detail?.coverPath, '/dl/gallery-dl/x/1 🎉.jpg');
    assert.deepEqual(
      detail?.events.map((e) => [e.type, e.level, e.code, e.params['legacyType'], e.legacyMessage]),
      [
        ['legacy', 'info', 'legacy', 'created', 'Download adicionado à conversa.'],
        ['legacy', 'info', 'legacy', 'started', 'Download iniciado com gallery-dl.'],
        ['legacy', 'success', 'legacy', 'completed', '2 baixado(s), 1 ignorado(s)']
      ]
    );
    const svg = files.listByConversation('c-done', 10, null).items.find((f) => f.name === '2.svg');
    assert.equal(svg?.mediaType, 'other', 'media type recomputed with the new classification');

    assert.deepEqual(
      (await cookies.list()).map((f) => f.name),
      ['reddit.cookies.txt', 'x.com.txt']
    );
    const materialized = await cookies.materialize('x.com.txt', path.join(root, 'job'));
    assert.ok(materialized.ok && readFileSync(materialized.value, 'utf8') === LEGACY_COOKIES);
    assert.deepEqual(await credentials.getPixiv(), {
      refreshToken: 'pixiv-token-123',
      userName: 'Artist',
      userId: '77',
      savedAt: 3_000
    });
    assert.deepEqual(settings.load(), {
      ...DEFAULT_HOST_SETTINGS,
      downloadDir: '/home/u/Downloads/Yami',
      defaultEngine: 'yt-dlp',
      runtimeMode: 'python',
      // not imported on purpose: legacy tools are not reused, the verified auto-install must run
      setupDismissed: false,
      cookies: { active: 'x.com.txt', fromBrowser: true, bindings: [] }
    });
    assert.equal(markers.get(LEGACY_IMPORT_MARKER), 9_000);
    assert.deepEqual(readdirSync(path.join(root, 'tmp')), [], 'temporary db copy removed');
  });

  it('runs only once', async () => {
    await importer().run();
    now = 10_000;
    const second = await importer().run();
    assert.equal(second.status, 'already-imported');
    assert.equal(second.conversations, 0);
    assert.equal(persistence.context.markers.get(LEGACY_IMPORT_MARKER), 9_000);
    assert.equal(persistence.context.conversations.list(100, null).items.length, 4);
  });

  it('is idempotent when an interrupted run (no marker) is repeated', async () => {
    await importer().run();
    const afterFirst = snapshot(legacyDir);
    // Interrupted before any step recorded itself: everything runs again and must not duplicate anything.
    for (const marker of ['', '.cookies', '.credentials', '.settings']) {
      persistence.context.markers.delete(`${LEGACY_IMPORT_MARKER}${marker}`);
    }
    const again = await importer().run();
    assert.deepEqual(snapshot(legacyDir), afterFirst, 'nothing else is deleted by the second run');
    assert.equal(again.status, 'imported');
    assert.equal(again.conversations, 0);
    assert.equal(again.batches, 0);
    assert.equal(again.files, 0);
    assert.equal(again.events, 0);
    // The imported plaintext files are gone; only the invalid one is still seen (and kept).
    assert.deepEqual(again.cookies, { imported: 0, existing: 0, invalid: 1 });
    assert.equal(again.plaintextSecretsRemoved, 0);
    assert.equal(again.plaintextSecretsKept, 1);
    assert.equal(again.pixivImported, false);
    assert.equal((await credentials.getPixiv())?.refreshToken, 'pixiv-token-123');
    assert.equal((await cookies.list()).length, 2);
    assert.equal(again.settingsImported, false);
    assert.equal(persistence.context.conversations.get('c-done')?.events.length, 3);
    assert.equal(persistence.context.files.countByConversation('c-done'), 2);
  });

  it('does nothing without a legacy directory', async () => {
    const report = await importer({ legacyDir: path.join(root, 'missing') }).run();
    assert.equal(report.status, 'no-legacy-data');
    assert.equal(persistence.context.markers.get(LEGACY_IMPORT_MARKER), null);
    assert.equal((await importer({ legacyDir: null }).run()).status, 'no-legacy-data');
  });

  it('keeps settings the user already chose and validates the download dir', async () => {
    persistence.context.settings.save({
      ...DEFAULT_HOST_SETTINGS,
      defaultEngine: 'gallery-dl',
      cookies: { active: 'mine.txt', fromBrowser: false, bindings: [] }
    });
    const seen: string[] = [];
    const report = await importer({
      validateDownloadDir: async (dir) => {
        seen.push(dir);
        return err(appError(ErrorCode.DOWNLOAD_DIR_FORBIDDEN));
      }
    }).run();
    assert.equal(report.settingsImported, true);
    assert.deepEqual(seen, ['/home/u/Downloads/Yami']);
    const loaded = persistence.context.settings.load();
    assert.equal(loaded.downloadDir, null);
    assert.equal(loaded.cookies.active, 'mine.txt');
    assert.equal(loaded.runtimeMode, 'python');

    // A run interrupted before the settings step recorded itself merges them again.
    persistence.context.markers.delete(LEGACY_IMPORT_MARKER);
    persistence.context.markers.delete(`${LEGACY_IMPORT_MARKER}.settings`);
    await importer({ validateDownloadDir: async (dir) => ok(`${dir}-canonical`) }).run();
    assert.equal(persistence.context.settings.load().downloadDir, '/home/u/Downloads/Yami-canonical');
  });

  it('tolerates a corrupt state.json and a corrupt legacy database (and leaves the import to a retry)', async () => {
    writeFileSync(path.join(legacyDir, 'state.json'), '{ not json');
    writeFileSync(path.join(legacyDir, 'yami.sqlite'), 'garbage '.repeat(1000));
    writeFileSync(path.join(legacyDir, 'yami.sqlite-wal'), 'garbage '.repeat(100));
    const before = snapshot(legacyDir);
    const report = await importer().run();
    assert.equal(report.status, 'incomplete');
    assert.equal(report.failedAttempts, 1);
    assert.equal(report.conversations, 0);
    assert.equal(report.settingsImported, false);
    assert.deepEqual(report.failedSteps, ['database']);
    assert.equal(report.cookies.imported, 2);
    assert.equal(report.pixivImported, true);
    assert.equal(report.plaintextSecretsRemoved, 0, 'no cleanup before the import finishes');
    assert.deepEqual(snapshot(legacyDir), before);
    assert.equal(persistence.context.markers.get(LEGACY_IMPORT_MARKER), null);
    assert.deepEqual(readdirSync(path.join(root, 'tmp')), []);
  });

  it('continues after a failing step', async () => {
    const failingVault: CookieVault = {
      list: async () => [],
      exists: async () => false,
      save: async () => {
        throw new Error('disk full');
      },
      remove: async () => ok(),
      materialize: async () => err(appError(ErrorCode.COOKIES_NOT_FOUND)),
      absorb: async () => undefined,
      domainsOf: async () => []
    };
    const report = await importer({ cookies: failingVault }).run();
    assert.deepEqual(report.failedSteps, ['cookies']);
    assert.equal(report.plaintextSecretsKept, 3, 'cookies that never reached the vault stay on disk');
    assert.equal(report.plaintextSecretsRemoved, 1, 'the Pixiv token did reach the vault');
    assert.ok(existsSync(path.join(legacyDir, 'cookies', 'x.com.txt')));
    assert.ok(!existsSync(path.join(legacyDir, 'credentials.json')));
    assert.equal(report.conversations, 4);
    assert.equal(persistence.context.downloads.get('c-run')?.cookieName, null, 'no vault name to map to');
    assert.equal(persistence.context.settings.load().cookies.active, null);
  });
});
