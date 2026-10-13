/**
 * Composition root, part 3: IPC controllers, event routing and app lifecycle wiring.
 * Called once, after `app.whenReady()`.
 */
import { Menu, app, clipboard, ipcMain, powerMonitor, screen } from 'electron';
import { IPC, type AppInfo } from '../../shared/contracts/ipc.ts';
import { installCrashHandlers, installProcessErrorLogging } from '../app/crash-handlers.ts';
import { extractHttpUrls } from '../features/clipboard/clipboard-urls.ts';
import { taskbarProgress } from '../features/tray/shell-status.ts';
import { routeHostEvents } from '../host-client/host-events.ts';
import { registerAccountsController } from '../ipc/controllers/accounts-controller.ts';
import { registerAppController } from '../ipc/controllers/app-controller.ts';
import { registerClipboardController } from '../ipc/controllers/clipboard-controller.ts';
import { registerDialogsController } from '../ipc/controllers/dialogs-controller.ts';
import { registerHostController } from '../ipc/controllers/host-controller.ts';
import { registerMediaController } from '../ipc/controllers/media-controller.ts';
import { registerSettingsController } from '../ipc/controllers/settings-controller.ts';
import { registerShellController } from '../ipc/controllers/shell-controller.ts';
import { registerTrayController } from '../ipc/controllers/tray-controller.ts';
import { registerUpdatesController } from '../ipc/controllers/updates-controller.ts';
import { registerVaultController } from '../ipc/controllers/vault-controller.ts';
import { registerWindowController } from '../ipc/controllers/window-controller.ts';
import { IpcRouter } from '../ipc/ipc-router.ts';
import { resolveTrustedSender } from '../security/sender-policy.ts';
import { siteHostOf } from '../../shared/domain/url.ts';
import { clampMainWindow } from '../windows/main-window.ts';
import { createCoreServices, type CoreServices } from './core-services.ts';
import { composeFeatures, type Features } from './compose-features.ts';
import { startSmokeTest, type ActiveSmoke } from './smoke.ts';

function registerIpc(core: CoreServices, features: Features): IpcRouter {
  const { hostClient, settings, origin } = core;
  const router = new IpcRouter(ipcMain, {
    resolveSender: (event) =>
      resolveTrustedSender(
        { webContentsId: event.sender.id, frame: event.senderFrame },
        { viewOf: (id) => features.windows.viewOf(id), isAppUrl: (url) => origin.isAppUrl(url) }
      ),
    logger: core.logger.child('ipc')
  });

  registerHostController(router, {
    forward: (command, payload) => hostClient.forward(command, payload),
    status: () => hostClient.status,
    restart: () => hostClient.restart()
  });
  registerAppController(router, {
    info: (view): AppInfo => ({
      version: app.getVersion(),
      platform: core.platform,
      isPackaged: app.isPackaged,
      view,
      paths: { data: core.paths.dataDir, logs: core.paths.logsDir },
      secretsProtected: (() => {
        const key = core.vault.load();
        return key.ok && key.value.protected;
      })()
    }),
    quit: () => features.quit.quit()
  });
  registerSettingsController(router, { get: () => settings.get(), update: (patch) => settings.update(patch) });
  registerWindowController(router, {
    windowFor: features.windowFor,
    hideTray: () => features.trayWindow.hide(),
    showMain: features.showMain
  });
  registerTrayController(router, {
    hide: () => features.trayWindow.hide(),
    setHeight: (height) => features.trayWindow.setHeight(height),
    dismissSuggestion: (url) => features.dismissed.add(url)
  });
  registerDialogsController(router, { chooseDownloadDir: (view) => features.downloadDir.choose(view) });
  registerShellController(router, features.shell);
  registerMediaController(router, features.media);
  registerClipboardController(router, () => clipboard.readText());
  registerAccountsController(router, features.accounts);
  registerVaultController(router, { reset: (view) => features.vaultReset.reset(view) });
  registerUpdatesController(router, features.updater);
  return router;
}

function wireEvents(core: CoreServices, features: Features): void {
  const { hostClient, settings } = core;
  const applyProgress = (progress: ReturnType<typeof taskbarProgress>): void => {
    const main = features.windowFor('main');
    if (!main) return;
    if (progress.mode === 'none') main.setProgressBar(-1);
    else main.setProgressBar(progress.value, { mode: progress.mode });
  };

  routeHostEvents({
    source: hostClient,
    broadcast: (channel, payload) => features.windows.broadcast(channel, payload),
    onDownloadFinished: (download) => features.notifier.downloadFinished(download),
    onBatchFinished: (batch) => features.notifier.batchFinished(batch),
    onState: (state) => {
      features.setLastState(state);
      features.trayIcon.setHostState(state);
      applyProgress(taskbarProgress(state));
    },
    onStatus: (status) => {
      features.trayIcon.setHostStatus(status);
      if (status.state !== 'ready') applyProgress(taskbarProgress(null));
      if (status.state === 'ready' && features.legacyImport.needed) void features.legacyImport.run();
    },
    onHistoryChanged: () => features.clipboardWatcher.invalidateHistory()
  });

  settings.onChange((next, previous) => {
    features.windows.broadcast(IPC.settings.changed, next);
    if (next.locale !== previous.locale) features.trayIcon.refreshLocale();
    if (next.clipboardWatch !== previous.clipboardWatch) features.clipboardWatcher.setEnabled(next.clipboardWatch);
    if (next.autoUpdate !== previous.autoUpdate) features.updater.refreshSchedule();
  });
  features.updater.onStatus((status) => features.windows.broadcast(IPC.updates.status, status));
}

function wireLifecycle(core: CoreServices, features: Features): void {
  const { quit, trayWindow } = features;
  app.on('before-quit', (event) => quit.onBeforeQuit(event));
  // The tray keeps the app alive; quitting is explicit (tray menu/panel, or close with closeToTray off).
  app.on('window-all-closed', () => undefined);
  app.on('second-instance', (_event, argv) => {
    // A URL passed to a second launch (e.g. "Open with") pre-fills the quick panel.
    const url = extractHttpUrls(argv.slice(1).join(' '), 1)[0];
    if (url) trayWindow.showUrl({ url, siteHost: siteHostOf(url) });
    else features.showMain();
  });
  app.on('activate', () => features.showMain());
  // Linux/macOS: delaying the OS shutdown lets running downloads be paused cleanly.
  powerMonitor.on('shutdown', (event?: unknown) => {
    const prevent: unknown =
      typeof event === 'object' && event !== null ? Reflect.get(event, 'preventDefault') : undefined;
    if (typeof prevent === 'function') Reflect.apply(prevent, event, []);
    quit.quit();
  });
  features.windowFor('main')?.on('session-end', () => quit.quit());

  const onDisplayChange = (): void => {
    const main = features.windowFor('main');
    if (main) clampMainWindow(main);
    trayWindow.repositionIfVisible();
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  installCrashHandlers({
    app,
    registry: features.windows,
    timers: core.timers,
    now: core.now,
    logger: core.logger.child('crash')
  });
}

/**
 * Builds and starts everything. `bundleDir` is the directory of `main.cjs`; `smoke` is set for
 * a `--yami-smoke-test` run (paths already sandboxed by `applySmokeSandbox`).
 */
export function startApp(bundleDir: string, smoke: ActiveSmoke | null = null): void {
  const core = createCoreServices(bundleDir);
  installProcessErrorLogging(core.logger.child('process'));
  // macOS needs an Edit menu for Cmd+C/V/X/A; other platforms use no menu at all.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null
  );

  const features = composeFeatures(core);
  registerIpc(core, features);
  wireEvents(core, features);
  wireLifecycle(core, features);

  core.hostClient.start();
  if (smoke) {
    // A smoke run only proves the app starts: no clipboard watching and no update checks
    // (an update downloaded here could be installed by the quit at the end of the run).
    startSmokeTest(smoke, {
      window: features.windowFor('main'),
      hostClient: core.hostClient,
      timers: core.timers,
      now: core.now,
      logger: core.logger.child('smoke'),
      quitWith: (finalize) => features.quit.quit(finalize)
    });
    return;
  }
  features.clipboardWatcher.setEnabled(core.settings.get().clipboardWatch);
  features.updater.refreshSchedule();
}
