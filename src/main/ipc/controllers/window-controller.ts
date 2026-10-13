/**
 * `window:*` — frameless window controls. They act on the *sender's* window (legacy
 * always acted on the main window, even from the tray panel): the tray panel can only
 * be closed (hidden); minimize/maximize from it are ignored.
 */
import type { BrowserWindow } from 'electron';
import { IPC, type AppView } from '../../../shared/contracts/ipc.ts';
import type { IpcRouter } from '../ipc-router.ts';

export interface WindowControllerDeps {
  readonly windowFor: (view: AppView) => BrowserWindow | null;
  readonly hideTray: () => void;
  readonly showMain: () => void;
}

export function registerWindowController(router: IpcRouter, deps: WindowControllerDeps): void {
  const main = (view: AppView): BrowserWindow | null => (view === 'main' ? deps.windowFor('main') : null);

  router.on(IPC.window.minimize, (ctx) => {
    main(ctx.view)?.minimize();
  });
  router.on(IPC.window.toggleMaximize, (ctx) => {
    const window = main(ctx.view);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  router.on(IPC.window.close, (ctx) => {
    // Main: `close` runs the window's close policy (hide to tray or quit).
    if (ctx.view === 'tray') deps.hideTray();
    else main(ctx.view)?.close();
  });
  router.handleValue(IPC.window.isMaximized, (ctx) => main(ctx.view)?.isMaximized() ?? false);
  router.on(IPC.window.showMain, (ctx) => {
    if (ctx.view === 'tray') deps.hideTray();
    deps.showMain();
  });
}
