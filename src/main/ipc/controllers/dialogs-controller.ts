/** `dialogs:*` — native dialogs that change host settings. */
import { IPC, type AppView } from '../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import { toIpcResult, type IpcRouter } from '../ipc-router.ts';

export interface DialogsControllerDeps {
  readonly chooseDownloadDir: (view: AppView) => Promise<Result<{ readonly downloadDir: string } | null, AppErrorData>>;
}

export function registerDialogsController(router: IpcRouter, deps: DialogsControllerDeps): void {
  router.handleResult(IPC.dialogs.chooseDownloadDir, async (ctx) =>
    toIpcResult(await deps.chooseDownloadDir(ctx.view))
  );
}
