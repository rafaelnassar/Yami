/** `updates:*` — app update status, manual check and install. */
import { IPC } from '../../../shared/contracts/ipc.ts';
import type { Updater } from '../../features/updates/updater.ts';
import { toIpcResult, type IpcRouter } from '../ipc-router.ts';

export function registerUpdatesController(router: IpcRouter, updater: Updater): void {
  router.handleValue(IPC.updates.getStatus, () => updater.status);
  router.handleResult(IPC.updates.check, async () => toIpcResult(await updater.check()));
  router.handleResult(IPC.updates.install, () => toIpcResult(updater.install()));
}
