import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_APP_SETTINGS } from '../../../shared/contracts/app-settings.ts';
import { err, ok } from '../../../shared/kernel/result.ts';
import { moveVaultAsideSync } from '../../infrastructure/broken-vault.ts';
import { FakeSafeStorage } from '../../infrastructure/fake-safe-storage.ts';
import { nullLogger } from '../../infrastructure/logger.ts';
import { VaultKeyStore } from '../../infrastructure/vault-key.ts';
import type { ConfirmOptions } from '../dialogs/native-dialogs.ts';
import { VaultResetService, type VaultResetDeps } from './vault-reset-service.ts';

const root = fs.mkdtempSync(path.join(tmpdir(), 'yami-vault-reset-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 8, 30, 8, 0, 0, 0);

/** A vault whose key was protected by a keystore that no longer decrypts it (DPAPI after a password reset). */
function brokenVault(name: string) {
  const vaultDir = path.join(root, name, 'data', 'vault');
  const keyFile = path.join(vaultDir, 'key.bin');
  const safe = new FakeSafeStorage();
  assert.ok(new VaultKeyStore(keyFile, safe, 'win32', nullLogger).load().ok);
  fs.mkdirSync(path.join(vaultDir, 'cookies'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'cookies', 'site.txt.enc'), 'sealed');
  safe.failDecrypt = true;
  return { vaultDir, keyFile, safe, store: new VaultKeyStore(keyFile, safe, 'win32', nullLogger) };
}

function setup(
  vault: ReturnType<typeof brokenVault>,
  options: { confirm?: boolean; restart?: VaultResetDeps['restartHost']; hostVaultReady?: boolean } = {}
) {
  const log: string[] = [];
  const prompts: ConfirmOptions[] = [];
  const service = new VaultResetService({
    hostVaultReady: () => options.hostVaultReady ?? false,
    loadKey: () => vault.store.load(),
    moveAside: () => {
      log.push('move-aside');
      return moveVaultAsideSync({ vaultDir: vault.vaultDir, keyFile: vault.keyFile }, NOW, nullLogger);
    },
    restartHost:
      options.restart ??
      (async (whileStopped) => {
        log.push('host-stopped');
        await whileStopped();
        log.push('host-started');
        return ok(null);
      }),
    dialogs: {
      confirm: async (_parent, prompt) => {
        prompts.push(prompt);
        log.push('confirm');
        return options.confirm ?? true;
      }
    },
    settings: { get: () => ({ ...DEFAULT_APP_SETTINGS, locale: 'en' }), onChange: () => () => undefined },
    windowFor: () => null,
    logger: nullLogger
  });
  return { service, log, prompts };
}

describe('VaultResetService', () => {
  it('asks first, then moves the vault aside with the host stopped and starts on a new key', async () => {
    const vault = brokenVault('a');
    const { service, log, prompts } = setup(vault);
    const result = await service.reset('main');
    assert.deepEqual(result, ok({ outcome: 'reset' }));
    assert.deepEqual(log, ['confirm', 'host-stopped', 'move-aside', 'host-started']);
    assert.match(prompts[0]?.detail ?? '', /Pixiv login will be lost/);
    assert.equal(prompts[0]?.confirmLabel, 'Reset');
    // The old vault is kept, never deleted…
    const kept = `${vault.vaultDir}.broken-2026-09-30T08-00-00-000Z`;
    assert.equal(fs.readFileSync(path.join(kept, 'cookies', 'site.txt.enc'), 'utf8'), 'sealed');
    assert.ok(fs.existsSync(path.join(kept, 'key.bin')));
    // …and a new, loadable key lives in a fresh, empty vault.
    assert.deepEqual(fs.readdirSync(vault.vaultDir), ['key.bin']);
    assert.equal(vault.store.load().ok, true);
  });

  it('changes nothing when the user cancels', async () => {
    const vault = brokenVault('b');
    const { service, log } = setup(vault, { confirm: false });
    assert.deepEqual(await service.reset('main'), ok({ outcome: 'cancelled' }));
    assert.deepEqual(log, ['confirm']);
    assert.ok(fs.existsSync(path.join(vault.vaultDir, 'cookies', 'site.txt.enc')));
  });

  it('only restarts the host when the key loads again (nothing is reset)', async () => {
    const vault = brokenVault('c');
    vault.safe.failDecrypt = false;
    const { service, log } = setup(vault);
    assert.deepEqual(await service.reset('main'), ok({ outcome: 'recovered' }));
    assert.deepEqual(log, ['host-stopped', 'host-started']);
    assert.ok(fs.existsSync(path.join(vault.vaultDir, 'cookies', 'site.txt.enc')));
  });

  it('keeps the vault when the key became loadable while the dialog was open', async () => {
    const vault = brokenVault('d');
    const { service, log } = setup(vault, {
      restart: async (whileStopped) => {
        vault.safe.failDecrypt = false;
        await whileStopped();
        return ok(null);
      }
    });
    assert.deepEqual(await service.reset('main'), ok({ outcome: 'recovered' }));
    assert.deepEqual(log, ['confirm']);
    assert.ok(fs.existsSync(path.join(vault.vaultDir, 'cookies', 'site.txt.enc')));
  });

  it('reports a failed move (the host still restarts, degraded) and a host that does not come back', async () => {
    const vault = brokenVault('e');
    const blocked = setup(vault, {
      restart: async (whileStopped) => {
        // Simulates a rename refused by the OS.
        fs.chmodSync(path.dirname(vault.vaultDir), 0o500);
        try {
          await whileStopped();
        } finally {
          fs.chmodSync(path.dirname(vault.vaultDir), 0o700);
        }
        return ok(null);
      }
    });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const result = await blocked.service.reset('main');
      assert.equal(!result.ok && result.error.code, 'FILE_OPERATION_FAILED');
      assert.ok(fs.existsSync(path.join(vault.vaultDir, 'cookies', 'site.txt.enc')));
    }

    const offline = setup(brokenVault('f'), { restart: async () => err({ code: 'HOST_UNAVAILABLE' }) });
    const result = await offline.service.reset('main');
    assert.equal(!result.ok && result.error.code, 'HOST_UNAVAILABLE');
  });

  it('leaves a host whose vault already works alone (no restart, no dialog)', async () => {
    const vault = brokenVault('h');
    vault.safe.failDecrypt = false;
    const { service, log } = setup(vault, { hostVaultReady: true });
    assert.deepEqual(await service.reset('main'), ok({ outcome: 'recovered' }));
    assert.deepEqual(log, []);
  });

  it('reports a done reset as pending (not failed) when the new host is slow to come up', async () => {
    const vault = brokenVault('i');
    const { service, log } = setup(vault, {
      restart: async (whileStopped) => {
        await whileStopped();
        return err({ code: 'HOST_TIMEOUT', params: { command: 'ready' } });
      }
    });
    assert.deepEqual(await service.reset('main'), ok({ outcome: 'reset-pending' }));
    assert.deepEqual(log, ['confirm', 'move-aside']);
    assert.deepEqual(fs.readdirSync(vault.vaultDir), ['key.bin']);
    assert.equal(vault.store.load().ok, true);
  });

  it('touches nothing and reports the error when the restart skipped the task', async () => {
    const vault = brokenVault('j');
    const { service, log } = setup(vault, {
      restart: async () => err({ code: 'HOST_TIMEOUT', params: { command: 'exit' } })
    });
    assert.deepEqual(await service.reset('main'), err({ code: 'HOST_TIMEOUT', params: { command: 'exit' } }));
    assert.deepEqual(log, ['confirm']);
    assert.ok(fs.existsSync(path.join(vault.vaultDir, 'cookies', 'site.txt.enc')));
  });

  it('is single-flight', async () => {
    const vault = brokenVault('g');
    let release: () => void = () => undefined;
    const { service, log } = setup(vault, {
      restart: async (whileStopped) => {
        await new Promise<void>((resolve) => (release = resolve));
        await whileStopped();
        return ok(null);
      }
    });
    const first = service.reset('main');
    const second = service.reset('tray');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.deepEqual(await first, ok({ outcome: 'reset' }));
    assert.equal(await second, await first);
    assert.equal(log.filter((entry) => entry === 'confirm').length, 1);
  });
});
