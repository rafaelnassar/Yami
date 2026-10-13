import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Schemas } from '../../shared/contracts/host-protocol.ts';
import { err, ok } from '../../shared/kernel/result.ts';
import { nullLogger } from '../infrastructure/logger.ts';
import { buildConfigurePayload, type ConfigureInput } from './configure-payload.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');

function input(loadVaultKey: ConfigureInput['loadVaultKey']): ConfigureInput {
  return {
    paths: { dataDir: '/d', runtimeDir: '/r', logsDir: '/l', tempDir: '/t', legacyDir: null, protectedDirs: ['/app'] },
    loadVaultKey,
    defaultDownloadDir: '/dl',
    isPackaged: true,
    appVersion: '2.1.0',
    logger: nullLogger
  };
}

describe('buildConfigurePayload', () => {
  it('sends the vault key when it loads', () => {
    const payload = buildConfigurePayload(input(() => ok({ keyBase64: KEY, protected: true })));
    assert.equal(payload.vaultKey, KEY);
    assert.equal(payload.vaultUnavailable, undefined);
    assert.ok(Schemas.configure.parse(payload).ok);
  });

  it('configures a disabled vault (no key, with the reason) instead of failing', () => {
    const payload = buildConfigurePayload(
      input(() => err({ code: 'VAULT_UNAVAILABLE', params: { reason: 'keystore' } }))
    );
    assert.equal(payload.vaultKey, null);
    assert.equal(payload.vaultUnavailable, 'keystore');
    assert.deepEqual(payload.paths.protectedDirs, ['/app']);
    // The host validates the payload again: the degraded shape must pass the contract.
    assert.ok(Schemas.configure.parse(payload).ok);
  });

  it('falls back to `io` for failures without a known reason', () => {
    const payload = buildConfigurePayload(input(() => err({ code: 'VAULT_UNAVAILABLE' })));
    assert.equal(payload.vaultUnavailable, 'io');
  });

  it('keeps the contract strict: a key-less payload needs no reason, a bad reason is refused', () => {
    const base = buildConfigurePayload(input(() => err({ code: 'VAULT_UNAVAILABLE' })));
    const withoutReason: Record<string, unknown> = { ...base };
    delete withoutReason['vaultUnavailable'];
    assert.ok(Schemas.configure.parse(withoutReason).ok);
    assert.equal(Schemas.configure.parse({ ...base, vaultUnavailable: 'nope' }).ok, false);
    assert.equal(Schemas.configure.parse({ ...base, vaultKey: 'not base64!' }).ok, false);
  });
});
