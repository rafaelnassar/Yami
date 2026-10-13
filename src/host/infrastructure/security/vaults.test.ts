import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { unwrap } from '../../../shared/kernel/result.ts';
import { captureLogger, makeTempDir } from '../persistence/test-fixtures.ts';
import { EncryptedCookieVault } from './encrypted-cookie-vault.ts';
import { EncryptedCredentialVault } from './encrypted-credential-vault.ts';
import { testBox, testKey, VALID_COOKIES } from './test-fixtures.ts';

const POSIX = process.platform !== 'win32';

describe('EncryptedCookieVault', () => {
  let dir: string;
  let cleanup: () => void;
  let key: string;
  let vault: EncryptedCookieVault;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir('yami-vault-'));
    key = testKey();
    vault = new EncryptedCookieVault({ dataDir: dir, box: testBox(key) });
  });
  afterEach(() => cleanup());

  it('saves encrypted files and lists them sorted with domains', async () => {
    const saved = unwrap(await vault.save('x.com.txt', VALID_COOKIES));
    assert.equal(saved.name, 'x.com.txt');
    assert.equal(saved.sizeBytes, Buffer.byteLength(VALID_COOKIES));
    assert.deepEqual(saved.domains, ['x.com', 'example.com', 'danbooru.donmai.us']);
    unwrap(await vault.save('Another.txt', 'a.test\tFALSE\t/\tFALSE\t0\tn\tv'));
    const file = path.join(dir, 'vault', 'cookies', 'x.com.txt.enc');
    const onDisk = readFileSync(file);
    assert.equal(onDisk.subarray(0, 3).toString('ascii'), 'YV1');
    assert.ok(!onDisk.toString('latin1').includes('auth_token'), 'stored encrypted');
    if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600);
    const list = await vault.list();
    assert.deepEqual(
      list.map((f) => f.name),
      ['Another.txt', 'x.com.txt']
    );
    assert.deepEqual(list[1]?.domains, saved.domains);
    assert.equal(list[1]?.sizeBytes, saved.sizeBytes);
    assert.deepEqual(await vault.domainsOf('x.com.txt'), saved.domains);
    assert.equal(await vault.exists('x.com.txt'), true);
    assert.equal(await vault.exists('nope.txt'), false);
    assert.equal(await vault.exists('../x.com.txt'), false);
  });

  it('returns an empty list when the vault directory does not exist', async () => {
    assert.deepEqual(await vault.list(), []);
  });

  it('rejects invalid names and formats without writing', async () => {
    const badName = await vault.save('../escape.txt', VALID_COOKIES);
    assert.equal(badName.ok ? null : badName.error.code, ErrorCode.COOKIES_INVALID_NAME);
    const badFormat = await vault.save('x.txt', 'not a cookie file');
    assert.equal(badFormat.ok ? null : badFormat.error.code, ErrorCode.COOKIES_INVALID_FORMAT);
    assert.deepEqual(await vault.list(), []);
  });

  it('removes files and reports missing ones', async () => {
    unwrap(await vault.save('x.txt', VALID_COOKIES));
    assert.equal((await vault.remove('x.txt')).ok, true);
    const again = await vault.remove('x.txt');
    assert.equal(again.ok ? null : again.error.code, ErrorCode.COOKIES_NOT_FOUND);
    const invalid = await vault.remove('bad/name.txt');
    assert.equal(invalid.ok ? null : invalid.error.code, ErrorCode.COOKIES_INVALID_NAME);
  });

  it('materializes plaintext with private permissions', async () => {
    unwrap(await vault.save('x.txt', VALID_COOKIES));
    const jobDir = path.join(dir, 'work', 'job1');
    const file = unwrap(await vault.materialize('x.txt', jobDir));
    assert.equal(file, path.join(jobDir, 'x.txt'));
    assert.equal(readFileSync(file, 'utf8'), VALID_COOKIES);
    if (POSIX) {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(jobDir).mode & 0o777, 0o700);
    }
    // Re-materializing over an existing (e.g. engine-updated) copy replaces it.
    writeFileSync(file, 'stale', { mode: 0o644 });
    unwrap(await vault.materialize('x.txt', jobDir));
    assert.equal(readFileSync(file, 'utf8'), VALID_COOKIES);
    if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600);
    const missing = await vault.materialize('missing.txt', jobDir);
    assert.equal(missing.ok ? null : missing.error.code, ErrorCode.COOKIES_NOT_FOUND);
  });

  it('absorbs valid updates and ignores invalid ones', async () => {
    unwrap(await vault.save('x.txt', VALID_COOKIES));
    const jobDir = path.join(dir, 'work');
    const copy = unwrap(await vault.materialize('x.txt', jobDir));
    const refreshed = `${VALID_COOKIES}\n.x.com\tTRUE\t/\tTRUE\t1893456000\tnew_session\tfresh`;
    writeFileSync(copy, refreshed);
    await vault.absorb('x.txt', copy);
    assert.equal(readFileSync(unwrap(await vault.materialize('x.txt', path.join(dir, 'w2'))), 'utf8'), refreshed);

    const garbage = unwrap(await vault.materialize('x.txt', path.join(dir, 'wg')));
    writeFileSync(garbage, 'garbage the engine wrote');
    await vault.absorb('x.txt', garbage);
    assert.equal(readFileSync(unwrap(await vault.materialize('x.txt', path.join(dir, 'w3'))), 'utf8'), refreshed);

    await vault.absorb('x.txt', path.join(dir, 'missing-file'));
    await vault.absorb('bad/name.txt', copy);
    const running = unwrap(await vault.materialize('x.txt', path.join(dir, 'w4')));
    unwrap(await vault.remove('x.txt'));
    writeFileSync(running, VALID_COOKIES);
    await vault.absorb('x.txt', running);
    assert.equal(await vault.exists('x.txt'), false, 'absorb never resurrects a removed file');
  });

  it('keeps a cookie file re-imported while the download ran (compare-and-swap)', async () => {
    const { logger, entries } = captureLogger();
    const logged = new EncryptedCookieVault({ dataDir: dir, box: testBox(key), logger });
    unwrap(await logged.save('x.txt', VALID_COOKIES));
    const copy = unwrap(await logged.materialize('x.txt', path.join(dir, 'work', 'job1')));
    const reimported = `${VALID_COOKIES}\n.x.com\tTRUE\t/\tTRUE\t1893456000\tauth_token\tnew-login`;
    unwrap(await logged.save('x.txt', reimported));
    writeFileSync(copy, `${VALID_COOKIES}\n.x.com\tTRUE\t/\tTRUE\t1893456000\tnew_session\tstale-job`);
    await logged.absorb('x.txt', copy);
    assert.equal(readFileSync(unwrap(await logged.materialize('x.txt', path.join(dir, 'w'))), 'utf8'), reimported);
    assert.ok(entries.some((e) => e.level === 'info' && e.message.includes('re-imported or removed')));

    // Re-importing identical content still counts as a user change (a content compare would miss it).
    const second = unwrap(await logged.materialize('x.txt', path.join(dir, 'work', 'job2')));
    unwrap(await logged.remove('x.txt'));
    unwrap(await logged.save('x.txt', reimported));
    writeFileSync(second, `${reimported}\n.x.com\tTRUE\t/\tTRUE\t1893456000\tnew_session\tstale-job`);
    await logged.absorb('x.txt', second);
    assert.equal(readFileSync(unwrap(await logged.materialize('x.txt', path.join(dir, 'w2'))), 'utf8'), reimported);
  });

  it('keeps the session of the job that finishes last when jobs share a cookie', async () => {
    unwrap(await vault.save('x.txt', VALID_COOKIES));
    const first = unwrap(await vault.materialize('x.txt', path.join(dir, 'work', 'a')));
    const second = unwrap(await vault.materialize('x.txt', path.join(dir, 'work', 'b')));
    const firstUpdate = `${VALID_COOKIES}\n.x.com\tTRUE\t/\tTRUE\t1893456000\tsession\tolder`;
    const secondUpdate = `${VALID_COOKIES}\n.x.com\tTRUE\t/\tTRUE\t1893456000\tsession\tfresher`;
    writeFileSync(first, firstUpdate);
    writeFileSync(second, secondUpdate);
    await vault.absorb('x.txt', first);
    await vault.absorb('x.txt', second);
    assert.equal(readFileSync(unwrap(await vault.materialize('x.txt', path.join(dir, 'w'))), 'utf8'), secondUpdate);
  });

  it('remembers live copies even after many runs released theirs without absorbing', async () => {
    unwrap(await vault.save('x.txt', VALID_COOKIES));
    const live = unwrap(await vault.materialize('x.txt', path.join(dir, 'work', 'live')));
    // More released copies (launch failures, discarded runs) than the vault tracks (256).
    for (let index = 0; index < 260; index += 1) {
      const released = unwrap(await vault.materialize('x.txt', path.join(dir, 'work', `gone-${index}`)));
      rmSync(released);
    }
    const refreshed = `${VALID_COOKIES}\n.x.com\tTRUE\t/\tTRUE\t1893456000\tsession\tlive`;
    writeFileSync(live, refreshed);
    await vault.absorb('x.txt', live);
    assert.equal(readFileSync(unwrap(await vault.materialize('x.txt', path.join(dir, 'w'))), 'utf8'), refreshed);
  });

  it('writes back only changed copies it handed out, once', async () => {
    unwrap(await vault.save('x.txt', VALID_COOKIES));
    const encrypted = path.join(dir, 'vault', 'cookies', 'x.txt.enc');
    const unchanged = unwrap(await vault.materialize('x.txt', path.join(dir, 'work', 'a')));
    const before = readFileSync(encrypted);
    await vault.absorb('x.txt', unchanged);
    assert.deepEqual(readFileSync(encrypted), before, 'an unchanged copy is not re-encrypted');

    const first = unwrap(await vault.materialize('x.txt', path.join(dir, 'work', 'b')));
    const firstUpdate = `${VALID_COOKIES}\n.x.com\tTRUE\t/\tTRUE\t1893456000\tsession\tfirst`;
    writeFileSync(first, firstUpdate);
    await vault.absorb('x.txt', first);
    assert.equal(readFileSync(unwrap(await vault.materialize('x.txt', path.join(dir, 'w5'))), 'utf8'), firstUpdate);

    // Absorbed once: a second absorb of the same copy, or of a file the vault never handed out, is ignored.
    writeFileSync(first, VALID_COOKIES);
    await vault.absorb('x.txt', first);
    const foreign = path.join(dir, 'work', 'foreign', 'x.txt');
    mkdirSync(path.dirname(foreign), { recursive: true });
    writeFileSync(foreign, VALID_COOKIES);
    await vault.absorb('x.txt', foreign);
    assert.equal(readFileSync(unwrap(await vault.materialize('x.txt', path.join(dir, 'w6'))), 'utf8'), firstUpdate);
  });

  it('fails with VAULT_UNAVAILABLE for a wrong key or a tampered file, but still lists the entry', async () => {
    unwrap(await vault.save('x.txt', VALID_COOKIES));
    const { logger, entries } = captureLogger();
    const other = new EncryptedCookieVault({ dataDir: dir, box: testBox(), logger });
    const wrongKey = await other.materialize('x.txt', path.join(dir, 'w'));
    assert.equal(wrongKey.ok ? null : wrongKey.error.code, ErrorCode.VAULT_UNAVAILABLE);
    assert.deepEqual(await other.domainsOf('x.txt'), []);
    const listed = await other.list();
    assert.deepEqual(
      listed.map((f) => [f.name, f.domains.length]),
      [['x.txt', 0]]
    );
    assert.ok(entries.some((e) => e.level === 'warn'));

    const file = path.join(dir, 'vault', 'cookies', 'x.txt.enc');
    const bytes = readFileSync(file);
    bytes[40] = (bytes[40] ?? 0) ^ 0xff;
    writeFileSync(file, bytes);
    const tampered = await vault.materialize('x.txt', path.join(dir, 'w'));
    assert.equal(tampered.ok ? null : tampered.error.code, ErrorCode.VAULT_UNAVAILABLE);
  });

  it('detects an encrypted file renamed to another cookie name', async () => {
    unwrap(await vault.save('a.txt', VALID_COOKIES));
    const cookiesDir = path.join(dir, 'vault', 'cookies');
    writeFileSync(path.join(cookiesDir, 'b.txt.enc'), readFileSync(path.join(cookiesDir, 'a.txt.enc')));
    const swapped = await vault.materialize('b.txt', path.join(dir, 'w'));
    assert.equal(swapped.ok ? null : swapped.error.code, ErrorCode.VAULT_UNAVAILABLE);
  });

  it('ignores stray files in the vault directory', async () => {
    const cookiesDir = path.join(dir, 'vault', 'cookies');
    mkdirSync(cookiesDir, { recursive: true });
    writeFileSync(path.join(cookiesDir, 'notes.md'), 'x');
    writeFileSync(path.join(cookiesDir, '..evil.txt.enc'), 'x');
    unwrap(await vault.save('ok.txt', VALID_COOKIES));
    assert.deepEqual(
      (await vault.list()).map((f) => f.name),
      ['ok.txt']
    );
    assert.deepEqual(
      readdirSync(cookiesDir).filter((n) => n.endsWith('.tmp')),
      []
    );
  });
});

describe('EncryptedCredentialVault', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = makeTempDir('yami-creds-')));
  afterEach(() => cleanup());

  const credentials = { refreshToken: 'tok_abcdefghij', userName: 'Artist', userId: '42', savedAt: 1_000 };

  it('round-trips pixiv credentials encrypted at rest', async () => {
    const vault = new EncryptedCredentialVault({ dataDir: dir, box: testBox() });
    assert.equal(await vault.getPixiv(), null);
    await vault.savePixiv(credentials);
    assert.deepEqual(await vault.getPixiv(), credentials);
    const file = path.join(dir, 'vault', 'credentials.enc');
    assert.ok(!readFileSync(file).toString('latin1').includes('tok_abcdefghij'));
    if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600);
    await vault.clearPixiv();
    assert.equal(await vault.getPixiv(), null);
    assert.equal(existsSync(file), false);
    await vault.clearPixiv();
  });

  it('treats a wrong key or corrupted store as empty and can overwrite it', async () => {
    const key = testKey();
    await new EncryptedCredentialVault({ dataDir: dir, box: testBox(key) }).savePixiv(credentials);
    const { logger, entries } = captureLogger();
    const other = new EncryptedCredentialVault({ dataDir: dir, box: testBox(), logger });
    assert.equal(await other.getPixiv(), null);
    assert.ok(entries.some((e) => e.level === 'warn'));
    await other.savePixiv({ ...credentials, userName: null });
    assert.equal((await other.getPixiv())?.userName, null);
    writeFileSync(path.join(dir, 'vault', 'credentials.enc'), 'garbage');
    assert.equal(await other.getPixiv(), null);
  });

  it('rejects invalid credentials', async () => {
    const vault = new EncryptedCredentialVault({ dataDir: dir, box: testBox() });
    await assert.rejects(() => vault.savePixiv({ ...credentials, refreshToken: '   ' }));
    assert.equal(await vault.getPixiv(), null);
  });
});
