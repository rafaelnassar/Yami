/**
 * Reset of a disabled secret vault. Main asks for a native confirmation, moves the
 * unreadable vault aside and restarts the host; this module only toasts the outcome. The
 * persistent notice disappears on its own once the new host state reports a working vault
 * (`vault-notice.ts`).
 */
import type { IpcResult, VaultResetResult } from '../../../shared/contracts/ipc.ts';
import { errorText, key, type NoticesStore } from '../notices/notices-store.ts';

export interface VaultActions {
  /** Single-flight. Resolves with the outcome, or `null` when it failed (already toasted). */
  reset(): Promise<VaultResetResult | null>;
}

export interface VaultActionsDeps {
  readonly reset: () => Promise<IpcResult<VaultResetResult>>;
  readonly notices: NoticesStore;
}

export function createVaultActions(deps: VaultActionsDeps): VaultActions {
  let running: Promise<VaultResetResult | null> | null = null;

  const run = async (): Promise<VaultResetResult | null> => {
    const result = await deps.reset();
    const toast = deps.notices.getState();
    if (!result.ok) {
      toast.push({ kind: 'error', title: key('ui.vault.resetFail'), message: errorText(result.error) });
      return null;
    }
    if (result.data.outcome === 'reset') {
      toast.push({ kind: 'success', title: key('ui.vault.resetDone'), message: key('ui.vault.resetDoneMsg') });
    } else if (result.data.outcome === 'reset-pending') {
      // Done on disk; the restarted host is just slow to come up (not a failure).
      toast.push({ kind: 'success', title: key('ui.vault.resetDone'), message: key('ui.vault.resetPendingMsg') });
    } else if (result.data.outcome === 'recovered') {
      toast.push({ kind: 'success', title: key('ui.vault.recovered'), message: key('ui.vault.recoveredMsg') });
    }
    return result.data;
  };

  return {
    reset() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    }
  };
}
