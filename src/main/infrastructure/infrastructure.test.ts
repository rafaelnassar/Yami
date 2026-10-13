import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { resolveAppPaths, type AppPathsInput } from './app-paths.ts';
import { FileLogger } from './file-logger.ts';
import { nullLogger } from './logger.ts';
import { FakeSafeStorage } from './fake-safe-storage.ts';
import { VaultKeyStore, vaultUnavailableReason } from './vault-key.ts';

const root = mkdtempSync(path.join(tmpdir(), 'yami-infra-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('resolveAppPaths', () => {
  const base: AppPathsInput = {
    platform: 'linux',
    userData: '/home/u/.config/Yami',
    logs: '/home/u/.config/Yami/logs',
    home: '/home/u',
    appPath: '/opt/yami/resources/app.asar',
    resourcesPath: '/opt/yami/resources',
    execPath: '/opt/yami/yami',
    env: {},
    exists: () => false
  };

  it('lays out linux paths (XDG runtime dir)', () => {
    const paths = resolveAppPaths({ ...base, env: { XDG_DATA_HOME: '/data' } });
    assert.equal(paths.dataDir, '/home/u/.config/Yami/data');
    assert.equal(paths.runtimeDir, '/data/yami/runtime');
    // Never the shared /tmp: other local users could pre-create or swap files there.
    assert.equal(paths.tempDir, '/home/u/.config/Yami/tmp');
    assert.equal(paths.legacyDir, null);
    assert.equal(paths.vaultDir, '/home/u/.config/Yami/data/vault');
    assert.equal(paths.vaultKeyFile, '/home/u/.config/Yami/data/vault/key.bin');
    assert.deepEqual(paths.protectedDirs, [
      '/home/u/.config/Yami',
      '/data/yami/runtime',
      '/home/u/.config/Yami/logs',
      '/opt/yami/resources/app.asar',
      '/opt/yami/resources',
      '/opt/yami'
    ]);
    assert.equal(resolveAppPaths(base).runtimeDir, '/home/u/.local/share/yami/runtime');
  });

  it('uses LOCALAPPDATA on Windows and detects the legacy dir', () => {
    const paths = resolveAppPaths({
      ...base,
      platform: 'win32',
      userData: 'C:\\Users\\u\\AppData\\Roaming\\Yami',
      home: 'C:\\Users\\u',
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      exists: (dir) => dir === 'C:\\Users\\u\\.yami'
    });
    assert.equal(paths.runtimeDir, 'C:\\Users\\u\\AppData\\Local\\Yami\\runtime');
    assert.equal(paths.legacyDir, 'C:\\Users\\u\\.yami');
    assert.equal(paths.dataDir, 'C:\\Users\\u\\AppData\\Roaming\\Yami\\data');
    assert.equal(paths.tempDir, 'C:\\Users\\u\\AppData\\Roaming\\Yami\\tmp');
  });

  it('keeps the runtime inside userData on macOS', () => {
    assert.equal(
      resolveAppPaths({ ...base, platform: 'darwin', userData: '/Users/u/Library/Application Support/Yami' })
        .runtimeDir,
      '/Users/u/Library/Application Support/Yami/runtime'
    );
  });
});

describe('FileLogger', () => {
  it('redacts secrets and rotates keeping 3 files', () => {
    const dir = path.join(root, 'logs');
    const logger = new FileLogger({ dir, maxBytes: 400, maxFiles: 3, sensitiveDirs: ['/secret/vault'] });
    logger.child('host').info('token refresh_token=abc123 at https://x.com/a?sig=zzz in /secret/vault/key.bin');
    const first = readFileSync(path.join(dir, 'main.log'), 'utf8');
    assert.ok(!first.includes('abc123'));
    assert.ok(!first.includes('sig=zzz'));
    assert.ok(!first.includes('/secret/vault'));
    assert.ok(first.includes('[host]'));
    for (let i = 0; i < 40; i += 1) logger.warn(`line ${i} ${'x'.repeat(40)}`);
    assert.ok(existsSync(path.join(dir, 'main.log.1')));
    assert.ok(existsSync(path.join(dir, 'main.log.2')));
    assert.ok(!existsSync(path.join(dir, 'main.log.3')));
    assert.ok(statSync(path.join(dir, 'main.log')).size <= 400);
  });
});

describe('VaultKeyStore', () => {
  it('creates a protected 32-byte key and reads it back', () => {
    const file = path.join(root, 'v1', 'key.bin');
    const safe = new FakeSafeStorage();
    const created = new VaultKeyStore(file, safe, 'linux', nullLogger).load();
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.equal(created.value.protected, true);
    assert.equal(Buffer.from(created.value.keyBase64, 'base64').length, 32);
    assert.ok(!readFileSync(file).includes(Buffer.from(created.value.keyBase64, 'base64')));
    const again = new VaultKeyStore(file, safe, 'linux', nullLogger).load();
    assert.deepEqual(again, created);
  });

  it('stores the key raw with 0600 when only basic_text is available, then upgrades', () => {
    const file = path.join(root, 'v2', 'key.bin');
    const safe = new FakeSafeStorage();
    safe.backend = 'basic_text';
    const raw = new VaultKeyStore(file, safe, 'linux', nullLogger).load();
    assert.ok(raw.ok && !raw.value.protected);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    safe.backend = 'kwallet5';
    const upgraded = new VaultKeyStore(file, safe, 'linux', nullLogger).load();
    assert.ok(upgraded.ok && upgraded.value.protected);
    assert.equal(raw.ok && upgraded.ok && raw.value.keyBase64 === upgraded.value.keyBase64, true);
  });

  it('never regenerates a key it cannot decrypt', () => {
    const file = path.join(root, 'v3', 'key.bin');
    const safe = new FakeSafeStorage();
    assert.ok(new VaultKeyStore(file, safe, 'win32', nullLogger).load().ok);
    const before = readFileSync(file);
    safe.failDecrypt = true;
    const denied = new VaultKeyStore(file, safe, 'win32', nullLogger).load();
    assert.equal(!denied.ok && denied.error.code, 'VAULT_UNAVAILABLE');
    assert.deepEqual(readFileSync(file), before);
    writeFileSync(file, 'garbage');
    assert.equal(new VaultKeyStore(file, safe, 'win32', nullLogger).load().ok, false);
  });

  it('reports why the key is unavailable (keystore, corrupted, io)', () => {
    const reasonOf = (store: VaultKeyStore): string | null => {
      const result = store.load();
      return result.ok ? null : vaultUnavailableReason(result.error);
    };
    const file = path.join(root, 'v4', 'key.bin');
    const safe = new FakeSafeStorage();
    assert.ok(new VaultKeyStore(file, safe, 'win32', nullLogger).load().ok);
    safe.failDecrypt = true;
    assert.equal(reasonOf(new VaultKeyStore(file, safe, 'win32', nullLogger)), 'keystore');
    safe.failDecrypt = false;
    safe.available = false;
    assert.equal(reasonOf(new VaultKeyStore(file, safe, 'win32', nullLogger)), 'keystore');
    safe.available = true;
    // Truncated file (e.g. a power cut during the write).
    writeFileSync(file, readFileSync(file).subarray(0, 3));
    assert.equal(reasonOf(new VaultKeyStore(file, safe, 'win32', nullLogger)), 'corrupted');
    writeFileSync(file, Buffer.concat([Buffer.from('YVK1', 'ascii'), Buffer.from([0]), Buffer.alloc(5)]));
    assert.equal(reasonOf(new VaultKeyStore(file, safe, 'win32', nullLogger)), 'corrupted');
    // key.bin is a directory: reading it fails with EISDIR.
    const dirAsFile = path.join(root, 'v5', 'key.bin');
    mkdirSync(dirAsFile, { recursive: true });
    assert.equal(reasonOf(new VaultKeyStore(dirAsFile, safe, 'win32', nullLogger)), 'io');
    assert.equal(vaultUnavailableReason({ code: 'VAULT_UNAVAILABLE' }), 'io');
  });
});
