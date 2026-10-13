import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { SqlitePersistence } from '../persistence/sqlite-persistence.ts';
import { captureLogger, makeTempDir, openTestPersistence } from '../persistence/test-fixtures.ts';
import { EncryptedCookieVault } from '../security/encrypted-cookie-vault.ts';
import { EncryptedCredentialVault } from '../security/encrypted-credential-vault.ts';
import { testBox } from '../security/test-fixtures.ts';
import {
  LEGACY_IMPORT_MARKER,
  LEGACY_IMPORT_MAX_ATTEMPTS,
  LegacyImporter,
  legacyImportMarkerPath,
  type LegacyImporterOptions
} from './legacy-importer.ts';
import { readLegacyState, type LegacyState } from './legacy-files.ts';
import { buildLegacyDir } from './test-fixtures.ts';

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

describe('LegacyImporter retries and markers', () => {
  let root: string;
  let cleanup: () => void;
  let legacyDir: string;
  let dataDir: string;
  let persistence: SqlitePersistence;
  let cookies: EncryptedCookieVault;
  let credentials: EncryptedCredentialVault;

  const legacyFile = (relative: string): string => path.join(legacyDir, relative);

  function importer(overrides: Partial<LegacyImporterOptions> = {}): LegacyImporter {
    return new LegacyImporter({
      target: persistence.context,
      cookies,
      credentials,
      logger: captureLogger().logger,
      clock: { now: () => 9_000 },
      legacyDir,
      workDir: path.join(root, 'tmp'),
      markerFile: legacyImportMarkerPath(dataDir),
      ...overrides
    });
  }

  /** Replaces the legacy database with garbage; returns a function restoring the original. */
  function breakLegacyDatabase(): () => void {
    const originals = ['yami.sqlite', 'yami.sqlite-wal'].map((name) => [name, readFileSync(legacyFile(name))] as const);
    writeFileSync(legacyFile('yami.sqlite'), 'garbage '.repeat(1000));
    writeFileSync(legacyFile('yami.sqlite-wal'), 'garbage '.repeat(100));
    return () => {
      for (const [name, bytes] of originals) writeFileSync(legacyFile(name), bytes);
    };
  }

  beforeEach(() => {
    ({ dir: root, cleanup } = makeTempDir('yami-legacy-retry-'));
    legacyDir = buildLegacyDir(root);
    dataDir = path.join(root, 'data');
    persistence = openTestPersistence(dataDir);
    const box = testBox();
    cookies = new EncryptedCookieVault({ dataDir, box });
    credentials = new EncryptedCredentialVault({ dataDir, box });
  });
  afterEach(() => {
    persistence.context.close();
    cleanup();
  });

  it('retries after the history failed, once, without undoing what the user changed in between', async () => {
    const restore = breakLegacyDatabase();
    const legacyBefore = snapshot(legacyDir);
    const first = await importer().run();
    assert.equal(first.status, 'incomplete');
    assert.deepEqual(first.failedSteps, ['database']);
    assert.equal(first.failedAttempts, 1);
    assert.equal(first.conversations, 0, 'state.json jobs wait for their history rows');
    assert.equal(first.pixivImported, true);
    assert.equal(first.settingsImported, true);
    assert.deepEqual(snapshot(legacyDir), legacyBefore, 'no plaintext secret deleted before the import finishes');
    assert.equal(persistence.context.markers.get(LEGACY_IMPORT_MARKER), null);
    assert.ok(!existsSync(legacyImportMarkerPath(dataDir)));

    // Between the two starts the user disconnects Pixiv, removes a cookie and changes a setting.
    await credentials.clearPixiv();
    assert.ok((await cookies.remove('reddit.cookies.txt')).ok);
    const settings = persistence.context.settings.load();
    persistence.context.settings.save({ ...settings, cookies: { ...settings.cookies, fromBrowser: false } });
    restore();

    const second = await importer().run();
    assert.equal(second.status, 'imported');
    assert.deepEqual(second.failedSteps, []);
    assert.equal(second.failedAttempts, 1);
    assert.equal(second.conversations, 4);
    assert.equal(second.files, 2);
    assert.equal(second.events, 4);
    assert.equal(second.pixivImported, false);
    assert.equal(second.settingsImported, false);
    const { downloads, conversations, markers } = persistence.context;
    assert.equal(downloads.get('c-run')?.cookieName, 'x.com.txt', 'cookie files were still there to map');
    assert.equal(conversations.get('c-run')?.events.length, 1, 'active job merged with its history row');
    assert.equal(conversations.list(100, null).items.length, 4);
    assert.equal(await credentials.getPixiv(), null, 'the disconnected account stays disconnected');
    assert.deepEqual(
      (await cookies.list()).map((f) => f.name),
      ['x.com.txt'],
      'the removed cookie is not re-imported'
    );
    assert.equal(persistence.context.settings.load().cookies.fromBrowser, false);
    // Only x.com.txt is proven identical to the vault; reddit, broken.txt and the Pixiv token stay.
    assert.equal(second.plaintextSecretsRemoved, 1);
    assert.equal(second.plaintextSecretsKept, 3);
    assert.ok(!existsSync(legacyFile('cookies/x.com.txt')));
    assert.ok(existsSync(legacyFile('cookies/reddit.cookies')) && existsSync(legacyFile('credentials.json')));
    assert.equal(markers.get(LEGACY_IMPORT_MARKER), 9_000);
    assert.deepEqual(JSON.parse(readFileSync(legacyImportMarkerPath(dataDir), 'utf8')), { importedAt: 9_000 });

    assert.equal((await importer().run()).status, 'already-imported');
    assert.equal(conversations.list(100, null).items.length, 4);
  });

  it(`finishes with what it could import after ${LEGACY_IMPORT_MAX_ATTEMPTS} failed attempts`, async () => {
    breakLegacyDatabase();
    for (let attempt = 1; attempt < LEGACY_IMPORT_MAX_ATTEMPTS; attempt += 1) {
      const report = await importer().run();
      assert.equal(report.status, 'incomplete');
      assert.equal(report.failedAttempts, attempt);
      assert.equal(report.plaintextSecretsRemoved, 0);
    }
    const last = await importer().run();
    assert.equal(last.status, 'imported');
    assert.deepEqual(last.failedSteps, ['database']);
    assert.equal(last.failedAttempts, LEGACY_IMPORT_MAX_ATTEMPTS);
    assert.equal(last.conversations, 2, 'the active jobs of state.json');
    assert.equal(last.pixivImported, false, 'imported by the first attempt');
    assert.equal(persistence.context.downloads.get('c-run')?.cookieName, 'x.com.txt');
    assert.equal(persistence.context.downloads.get('c-run')?.status, 'paused');
    assert.equal(last.plaintextSecretsRemoved, 3);
    assert.equal(persistence.context.markers.get(LEGACY_IMPORT_MARKER), 9_000);
    assert.equal((await importer().run()).status, 'already-imported');
  });

  it('never imports again into a recreated database once the marker file exists', async () => {
    await importer().run();
    persistence.context.close();
    // Same data dir marker file, brand-new database (as after a corrupted database was recreated).
    persistence = openTestPersistence(path.join(root, 'fresh-db'));
    const report = await importer().run();
    assert.equal(report.status, 'already-imported');
    assert.equal(persistence.context.conversations.list(100, null).items.length, 0);
    assert.equal(persistence.context.markers.get(LEGACY_IMPORT_MARKER), 9_000, 'database marker restored');
  });

  it('writes the marker file for an import finished before it existed', async () => {
    persistence.context.markers.set(LEGACY_IMPORT_MARKER, 1_234);
    assert.equal((await importer().run()).status, 'already-imported');
    assert.deepEqual(JSON.parse(readFileSync(legacyImportMarkerPath(dataDir), 'utf8')), { importedAt: 1_234 });
  });

  it('treats an unreadable marker file as imported', async () => {
    writeFileSync(legacyImportMarkerPath(dataDir), '{ torn');
    assert.equal((await importer().run()).status, 'already-imported');
    assert.equal(persistence.context.conversations.list(100, null).items.length, 0);
  });

  it('waits for state.json before importing conversations, so active jobs keep its overlay', async () => {
    let stateFails = true;
    const readState = async (dir: string): Promise<LegacyState | null> => {
      if (stateFails) throw new Error('EIO: i/o error');
      return readLegacyState(dir);
    };
    const legacyBefore = snapshot(legacyDir);
    const first = await importer({ readState }).run();
    assert.equal(first.status, 'incomplete');
    assert.deepEqual(first.failedSteps, ['state']);
    assert.equal(first.failedAttempts, 1);
    assert.equal(first.conversations, 0, 'not imported from the database rows alone');
    assert.equal(first.settingsImported, false);
    assert.deepEqual(snapshot(legacyDir), legacyBefore);

    stateFails = false;
    const second = await importer({ readState }).run();
    assert.equal(second.status, 'imported');
    assert.equal(second.conversations, 4);
    assert.equal(second.settingsImported, true);
    const running = persistence.context.downloads.get('c-run');
    assert.equal(running?.status, 'paused');
    assert.equal(running?.cookieName, 'x.com.txt');
    assert.equal(running?.batchId, 'b-live');
    assert.deepEqual(running?.counters, { done: 3, skipped: 1, errors: 0 }, 'fresher counters of state.json');
    assert.equal(persistence.context.downloads.get('c-pend')?.status, 'paused', 'job known only to state.json');
    assert.equal(persistence.context.settings.load().cookies.active, 'x.com.txt');
  });

  it('imports the database rows alone on the last attempt when state.json never becomes readable', async () => {
    const readState = async (): Promise<LegacyState | null> => {
      throw new Error('EIO: i/o error');
    };
    for (let attempt = 1; attempt < LEGACY_IMPORT_MAX_ATTEMPTS; attempt += 1) {
      assert.equal((await importer({ readState }).run()).conversations, 0);
    }
    const last = await importer({ readState }).run();
    assert.equal(last.status, 'imported');
    assert.deepEqual(last.failedSteps, ['state']);
    assert.equal(last.conversations, 3, 'c-done, c-fail and c-run from the database');
    assert.equal(persistence.context.downloads.get('c-pend'), null);
  });

  it('tells whether an import is pending without touching anything', async () => {
    const legacyBefore = snapshot(legacyDir);
    assert.equal(await importer().pending(), true);
    assert.equal(await importer({ legacyDir: path.join(root, 'missing') }).pending(), false);
    assert.deepEqual(snapshot(legacyDir), legacyBefore);
    assert.deepEqual(await cookies.list(), []);
    assert.equal(persistence.context.conversations.list(100, null).items.length, 0);
    await importer().run();
    assert.equal(await importer().pending(), false);
  });
});
