import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IpcResult, VaultResetResult } from '../../../shared/contracts/ipc.ts';
import { createNoticesStore } from '../notices/notices-store.ts';
import { createVaultActions } from './vault-actions.ts';
import { VAULT_NOTICE_ID, syncVaultNotice, vaultStatusKey } from './vault-notice.ts';

describe('vault notice', () => {
  it('shows a sticky notice with the reset action while the vault is disabled, and drops it once it works', () => {
    const notices = createNoticesStore({ now: () => 1 });
    syncVaultNotice(notices, null);
    assert.equal(notices.getState().toasts.length, 0);
    syncVaultNotice(notices, { state: 'disabled', reason: 'keystore' });
    const [toast] = notices.getState().toasts;
    assert.equal(toast?.id, VAULT_NOTICE_ID);
    assert.equal(toast?.kind, 'warn');
    assert.equal(toast?.sticky, true);
    assert.deepEqual(toast?.action, { type: 'vault-reset' });
    syncVaultNotice(notices, { state: 'disabled', reason: 'keystore' });
    assert.equal(notices.getState().toasts.length, 1);
    syncVaultNotice(notices, { state: 'ready' });
    assert.equal(notices.getState().toasts.length, 0);
  });

  it('stays hidden for the session once dismissed', () => {
    const notices = createNoticesStore({ now: () => 1 });
    syncVaultNotice(notices, { state: 'disabled', reason: 'corrupted' });
    notices.getState().dismiss(VAULT_NOTICE_ID);
    syncVaultNotice(notices, { state: 'disabled', reason: 'corrupted' });
    assert.equal(notices.getState().toasts.length, 0);
  });

  it('keys statuses by state and reason (snapshots are new objects)', () => {
    assert.equal(vaultStatusKey(undefined), '');
    assert.equal(vaultStatusKey({ state: 'ready' }), 'ready');
    assert.equal(vaultStatusKey({ state: 'disabled', reason: 'io' }), 'disabled:io');
  });
});

describe('vault actions', () => {
  function setup(results: IpcResult<VaultResetResult>[]) {
    // Each toast at a distinct time (identical toasts close together are merged).
    let now = 0;
    const notices = createNoticesStore({ now: () => (now += 10_000) });
    let calls = 0;
    const actions = createVaultActions({
      reset: async () => {
        calls += 1;
        return results.shift() ?? { ok: false, error: { code: 'INTERNAL' } };
      },
      notices
    });
    return { notices, actions, calls: () => calls };
  }

  it('toasts each outcome (nothing for a cancelled confirmation)', async () => {
    const { notices, actions } = setup([
      { ok: true, data: { outcome: 'cancelled' } },
      { ok: true, data: { outcome: 'reset' } },
      { ok: true, data: { outcome: 'recovered' } },
      { ok: true, data: { outcome: 'reset-pending' } },
      { ok: false, error: { code: 'FILE_OPERATION_FAILED' } }
    ]);
    assert.deepEqual(await actions.reset(), { outcome: 'cancelled' });
    assert.equal(notices.getState().toasts.length, 0);
    assert.deepEqual(await actions.reset(), { outcome: 'reset' });
    assert.deepEqual(await actions.reset(), { outcome: 'recovered' });
    assert.deepEqual(await actions.reset(), { outcome: 'reset-pending' });
    assert.equal(await actions.reset(), null);
    const texts = notices
      .getState()
      .toasts.map((toast) => [
        toast.kind,
        toast.title?.kind === 'key' ? toast.title.key : '',
        toast.message?.kind === 'key' ? toast.message.key : ''
      ]);
    assert.deepEqual(texts, [
      ['success', 'ui.vault.resetDone', 'ui.vault.resetDoneMsg'],
      ['success', 'ui.vault.recovered', 'ui.vault.recoveredMsg'],
      // A done reset whose host is slow to come up is not reported as a failure.
      ['success', 'ui.vault.resetDone', 'ui.vault.resetPendingMsg'],
      ['error', 'ui.vault.resetFail', '']
    ]);
  });

  it('is single-flight (toast button and settings banner may both trigger it)', async () => {
    const { actions, calls } = setup([{ ok: true, data: { outcome: 'reset' } }]);
    const [first, second] = await Promise.all([actions.reset(), actions.reset()]);
    assert.equal(calls(), 1);
    assert.equal(first, second);
  });
});
