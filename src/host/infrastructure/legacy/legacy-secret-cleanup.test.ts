import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { err } from '../../../shared/kernel/result.ts';
import type { CookieVault } from '../../application/ports/secrets.ts';
import type { SqlitePersistence } from '../persistence/sqlite-persistence.ts';
import { captureLogger, makeTempDir, openTestPersistence, type CapturedLog } from '../persistence/test-fixtures.ts';
import { EncryptedCookieVault } from '../security/encrypted-cookie-vault.ts';
import { EncryptedCredentialVault } from '../security/encrypted-credential-vault.ts';
import { VALID_COOKIES, testBox } from '../security/test-fixtures.ts';
import { LEGACY_IMPORT_MARKER, LegacyImporter, type LegacyImporterOptions } from './legacy-importer.ts';
import { LEGACY_COOKIES, buildLegacyDir } from './test-fixtures.ts';

describe('LegacyImporter plaintext secrets cleanup', () => {
  let root: string;
  let cleanup: () => void;
  let legacyDir: string;
  let persistence: SqlitePersistence;
  let cookies: EncryptedCookieVault;
  let credentials: EncryptedCredentialVault;
  let logs: CapturedLog[];

  const legacyFile = (relative: string): string => path.join(legacyDir, relative);

  function importer(overrides: Partial<LegacyImporterOptions> = {}): LegacyImporter {
    const captured = captureLogger();
    logs = captured.entries;
    return new LegacyImporter({
      target: persistence.context,
      cookies,
      credentials,
      logger: captured.logger,
      clock: { now: () => 9_000 },
      legacyDir,
      workDir: path.join(root, 'tmp'),
      ...overrides
    });
  }

  function warnings(): string[] {
    return logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
  }

  beforeEach(() => {
    ({ dir: root, cleanup } = makeTempDir('yami-legacy-secrets-'));
    legacyDir = buildLegacyDir(root);
    const dataDir = path.join(root, 'data');
    persistence = openTestPersistence(dataDir);
    const box = testBox();
    cookies = new EncryptedCookieVault({ dataDir, box });
    credentials = new EncryptedCredentialVault({ dataDir, box });
  });
  afterEach(() => {
    persistence.context.close();
    cleanup();
  });

  it('never deletes invalid cookie files, hidden files or non-secret legacy data', async () => {
    writeFileSync(legacyFile('cookies/huge.txt'), 'x'.repeat(5 * 1024 * 1024 + 1));
    const report = await importer().run();
    assert.equal(report.cookies.invalid, 2);
    assert.equal(report.plaintextSecretsRemoved, 3);
    assert.equal(report.plaintextSecretsKept, 2);
    assert.deepEqual(readdirSync(legacyFile('cookies')).sort(), ['.hidden', 'broken.txt', 'huge.txt']);
    assert.equal(readFileSync(legacyFile('cookies/broken.txt'), 'utf8'), 'not cookies');
    for (const kept of ['state.json', 'yami.sqlite', 'yami.sqlite-wal']) assert.ok(existsSync(legacyFile(kept)), kept);
    assert.deepEqual(readdirSync(path.join(root, 'tmp')), [], 'verification copies removed');
  });

  it('keeps every secret when deletion fails and removes them when the interrupted run is repeated', async () => {
    const attempts: string[] = [];
    const first = await importer({
      removeFile: async (file) => {
        attempts.push(path.relative(legacyDir, file).split(path.sep).join('/'));
        throw new Error('EBUSY: resource busy');
      }
    }).run();
    assert.deepEqual(first.failedSteps, [], 'deletion failures are not fatal');
    assert.deepEqual(first.cookies, { imported: 2, existing: 0, invalid: 1 });
    assert.equal(first.pixivImported, true);
    assert.equal(first.plaintextSecretsRemoved, 0);
    assert.equal(first.plaintextSecretsKept, 4);
    assert.deepEqual(attempts.sort(), ['cookies/reddit.cookies', 'cookies/x.com.txt', 'credentials.json']);
    assert.equal(warnings().filter((message) => message.includes('could not be removed')).length, 3);
    assert.ok(existsSync(legacyFile('cookies/x.com.txt')) && existsSync(legacyFile('credentials.json')));
    assert.deepEqual(readdirSync(path.join(root, 'tmp')), []);

    persistence.context.markers.delete(LEGACY_IMPORT_MARKER);
    const second = await importer().run();
    assert.deepEqual(second.cookies, { imported: 0, existing: 2, invalid: 1 });
    assert.equal(second.plaintextSecretsRemoved, 3, 'already-present vault entries with identical content');
    assert.equal(second.plaintextSecretsKept, 1);
    assert.deepEqual(readdirSync(legacyFile('cookies')).sort(), ['.hidden', 'broken.txt']);
    assert.ok(!existsSync(legacyFile('credentials.json')));
  });

  it('keeps legacy secrets that differ from what the vault already holds', async () => {
    assert.ok((await cookies.save('x.com.txt', VALID_COOKIES)).ok);
    await credentials.savePixiv({ refreshToken: 'newer-token', userName: null, userId: null, savedAt: 1 });
    const report = await importer().run();
    assert.deepEqual(report.cookies, { imported: 1, existing: 1, invalid: 1 });
    assert.equal(report.pixivImported, false);
    assert.equal(report.plaintextSecretsRemoved, 1, 'only reddit.cookies was proven identical');
    assert.equal(report.plaintextSecretsKept, 3);
    assert.equal(readFileSync(legacyFile('cookies/x.com.txt'), 'utf8'), LEGACY_COOKIES);
    assert.ok(existsSync(legacyFile('credentials.json')));
    assert.ok(!existsSync(legacyFile('cookies/reddit.cookies')));
    assert.equal((await credentials.getPixiv())?.refreshToken, 'newer-token');
    assert.ok(warnings().includes('legacy cookie file kept: vault holds different content'));
    assert.ok(warnings().includes('legacy Pixiv credentials kept: token not in the vault'));
  });

  it('keeps cookie files whose vault entry cannot be read back', async () => {
    const unreadable: CookieVault = {
      list: () => cookies.list(),
      exists: (name) => cookies.exists(name),
      save: (name, content) => cookies.save(name, content),
      remove: (name) => cookies.remove(name),
      materialize: async () => err(appError(ErrorCode.COOKIES_NOT_FOUND)),
      absorb: (name, file) => cookies.absorb(name, file),
      domainsOf: (name) => cookies.domainsOf(name)
    };
    const report = await importer({ cookies: unreadable }).run();
    assert.equal(report.cookies.imported, 2);
    assert.equal(report.plaintextSecretsRemoved, 1);
    assert.equal(report.plaintextSecretsKept, 3);
    assert.ok(existsSync(legacyFile('cookies/x.com.txt')) && existsSync(legacyFile('cookies/reddit.cookies')));
  });

  for (const [label, content] of [
    ['has no Pixiv token', '{"pixiv": null}'],
    ['is corrupt', '{ not json']
  ] as const) {
    it(`leaves credentials.json alone when it ${label}`, async () => {
      writeFileSync(legacyFile('credentials.json'), content);
      const report = await importer().run();
      assert.equal(report.pixivImported, false);
      assert.equal(readFileSync(legacyFile('credentials.json'), 'utf8'), content);
      assert.equal(report.plaintextSecretsRemoved, 2);
      assert.equal(report.plaintextSecretsKept, 1, 'only broken.txt: no identifiable secret in credentials.json');
    });
  }
});
