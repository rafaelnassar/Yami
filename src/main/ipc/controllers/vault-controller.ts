/** `vault:*` — reset of a vault whose key cannot be loaded (native confirmation in main). */
import { IPC, IpcSchemas, type AppView, type VaultResetResult } from '../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import { parseArg, toIpcResult, type IpcRouter } from '../ipc-router.ts';

export interface VaultControllerDeps {
  readonly reset: (view: AppView) => Promise<Result<VaultResetResult, AppErrorData>>;
}

export function registerVaultController(router: IpcRouter, deps: VaultControllerDeps): void {
  router.handleResult(IPC.vault.reset, async (ctx, arg) => {
    const parsed = parseArg(IpcSchemas.resetVault, arg);
    if (!parsed.ok) return toIpcResult(parsed);
    return toIpcResult(await deps.reset(ctx.view));
  });
}
