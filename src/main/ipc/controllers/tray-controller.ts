/** `tray:*` — quick panel commands (only honored from the tray panel itself). */
import { IPC, IpcSchemas } from '../../../shared/contracts/ipc.ts';
import { parseArg, type IpcRouter } from '../ipc-router.ts';

export interface TrayControllerDeps {
  readonly hide: () => void;
  readonly setHeight: (height: number) => void;
  readonly dismissSuggestion: (url: string) => void;
}

export function registerTrayController(router: IpcRouter, deps: TrayControllerDeps): void {
  router.on(IPC.tray.hide, (ctx) => {
    if (ctx.view === 'tray') deps.hide();
  });
  router.on(IPC.tray.setHeight, (ctx, arg) => {
    const parsed = parseArg(IpcSchemas.trayHeight, arg);
    if (ctx.view === 'tray' && parsed.ok) deps.setHeight(parsed.value.height);
  });
  router.on(IPC.tray.dismissSuggestion, (ctx, arg) => {
    const parsed = parseArg(IpcSchemas.dismissSuggestion, arg);
    if (ctx.view === 'tray' && parsed.ok) deps.dismissSuggestion(parsed.value.url);
  });
}
