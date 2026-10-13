/** `app:*` — app information and quit. */
import { IPC, type AppInfo, type AppView } from '../../../shared/contracts/ipc.ts';
import type { IpcRouter } from '../ipc-router.ts';

export interface AppControllerDeps {
  readonly info: (view: AppView) => AppInfo;
  readonly quit: () => void;
}

export function registerAppController(router: IpcRouter, deps: AppControllerDeps): void {
  router.handleValue(IPC.app.getInfo, (ctx) => deps.info(ctx.view));
  router.on(IPC.app.quit, () => deps.quit());
}
