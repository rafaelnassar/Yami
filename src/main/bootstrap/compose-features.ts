/**
 * Composition root, part 2: windows, tray, OS integrations and feature services.
 */
import { stat } from 'node:fs/promises';
import { BrowserWindow, app, clipboard, shell } from 'electron';
import type { HostStateDto } from '../../shared/contracts/dto.ts';
import { IPC, type AppView } from '../../shared/contracts/ipc.ts';
import { translatorFor } from '../../shared/i18n/catalog.ts';
import { QuitCoordinator } from '../app/quit-coordinator.ts';
import { OAuthAccounts } from '../features/accounts/oauth-accounts.ts';
import { runSiteOAuth } from '../features/accounts/site-oauth.ts';
import { clearPixivSession, runPixivOAuth } from '../features/accounts/pixiv-oauth.ts';
import { clearSiteOAuthSession } from '../features/accounts/site-oauth.ts';
import type { VaultSiteId } from '../../shared/domain/oauth-sites.ts';
import { ClipboardWatcher } from '../features/clipboard/clipboard-watcher.ts';
import { DismissedUrls } from '../features/clipboard/dismissed-urls.ts';
import { DownloadDirDialog } from '../features/dialogs/download-dir-dialog.ts';
import { electronDialogs } from '../features/dialogs/native-dialogs.ts';
import { watchDownloadDir } from '../features/media/download-dir-watch.ts';
import { nodeMediaFiles } from '../features/media/media-files.ts';
import { MediaService } from '../features/media/media-service.ts';
import { ThumbnailCache } from '../features/media/thumbnail-cache.ts';
import { createNativeThumbnailRenderer } from '../features/media/thumbnail-renderer.ts';
import { Notifier } from '../features/notifications/notifier.ts';
import { ShellService } from '../features/shell/shell-service.ts';
import { TrayIcon } from '../features/tray/tray-icon.ts';
import { Updater, isPortableBuild } from '../features/updates/updater.ts';
import { loadElectronUpdater } from '../features/updates/updater-loader.ts';
import { VaultResetService } from '../features/vault/vault-reset-service.ts';
import { moveVaultAsideSync } from '../infrastructure/broken-vault.ts';
import { createLegacyStorageReader } from '../infrastructure/legacy-storage-reader.ts';
import { LegacyUiImporter } from '../infrastructure/legacy-ui-import.ts';
import { externalUrlOf } from '../security/navigation-policy.ts';
import { createMainWindow, showMainWindow } from '../windows/main-window.ts';
import { TrayWindow } from '../windows/tray-window.ts';
import { WindowRegistry } from '../windows/window-registry.ts';
import type { CoreServices } from './core-services.ts';
import { resolveIcons } from './icons.ts';

export interface Features {
  readonly windows: WindowRegistry;
  readonly trayWindow: TrayWindow;
  readonly trayIcon: TrayIcon;
  readonly quit: QuitCoordinator;
  readonly notifier: Notifier;
  readonly clipboardWatcher: ClipboardWatcher;
  readonly dismissed: DismissedUrls;
  readonly media: MediaService;
  readonly shell: ShellService;
  readonly downloadDir: DownloadDirDialog;
  readonly accounts: OAuthAccounts;
  readonly vaultReset: VaultResetService;
  readonly updater: Updater;
  readonly legacyImport: LegacyUiImporter;
  readonly showMain: () => void;
  readonly windowFor: (view: AppView) => BrowserWindow | null;
  readonly setLastState: (state: HostStateDto) => void;
}

export function composeFeatures(core: CoreServices): Features {
  const { hostClient, settings, logger, timers, now, origin, paths } = core;
  const icons = resolveIcons(core.bundleDir, process.platform);
  const windows = new WindowRegistry();
  const windowFor = (view: AppView): BrowserWindow | null => windows.get(view);
  const isAppUrl = (url: string): boolean => origin.isAppUrl(url);
  const openExternal = (url: string): void => {
    const safe = externalUrlOf(url);
    if (safe)
      void shell
        .openExternal(safe)
        .catch((error: unknown) => logger.warn('openExternal failed', { error: String(error) }));
  };
  let lastState: HostStateDto | null = null;
  // Media tokens prove containment in the download folder only as of their issue: revoke them on change.
  const observeDownloadDir = watchDownloadDir(() => core.mediaRegistry.clear());
  const vaultReady = core.hostVaultReady;

  const updater = new Updater({
    isPackaged: app.isPackaged,
    isPortable: isPortableBuild(process.env),
    autoUpdateEnabled: () => settings.get().autoUpdate,
    loadEngine: () => loadElectronUpdater(logger.child('updater')),
    quitWith: (finalize) => quit.quit(finalize),
    timers,
    now,
    logger: logger.child('updater')
  });

  const clipboardWatcher = new ClipboardWatcher({
    readText: () => clipboard.readText(),
    fetchHistory: () => hostClient.request('downloads.history', { limit: 2_000 }),
    hostReady: () => hostClient.isReady,
    panelVisible: () => trayWindow.isVisible(),
    isDismissed: (url) => dismissed.has(url),
    suggest: (suggestion) => trayWindow.showSuggestion(suggestion),
    timers,
    now,
    logger: logger.child('clipboard')
  });
  const dismissed = new DismissedUrls(paths.clipboardDismissedFile, logger.child('clipboard'));

  const quit = new QuitCoordinator({
    stopBackgroundWork: () => {
      // Look closed right away: pausing downloads in the host may take up to ~15 s.
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.hide();
      }
      clipboardWatcher.stop();
      updater.dispose();
      trayWindow.destroy();
      // Also avoids a stale notification-area icon after the forced exit on Windows.
      trayIcon.destroy();
    },
    shutdownHost: () => hostClient.shutdown(),
    exit: () => {
      if (!updater.installOnQuit()) app.exit(0);
    },
    forceExit: () => app.exit(0),
    logger: logger.child('quit')
  });

  const showMain = (): void => {
    // Second launch, dock click…: nothing may reappear while the quit sequence runs.
    if (quit.isQuitting) return;
    trayWindow.hide();
    showMainWindow(windows.get('main'));
  };

  const trayWindow = new TrayWindow({
    bundleDir: core.bundleDir,
    isPackaged: app.isPackaged,
    entryUrl: origin.entryUrl('tray'),
    isAppUrl,
    openExternal,
    isQuitting: () => quit.isQuitting,
    trayBounds: () => trayIcon.bounds(),
    registry: windows,
    timers,
    logger: logger.child('tray-window')
  });

  const mainWindow = createMainWindow({
    bundleDir: core.bundleDir,
    isPackaged: app.isPackaged,
    openDevTools: origin.isDevServer,
    iconPath: icons.window,
    entryUrl: origin.entryUrl('main'),
    isAppUrl,
    openExternal,
    isQuitting: () => quit.isQuitting,
    closeToTray: () => settings.get().closeToTray,
    requestQuit: () => quit.quit(),
    onMaximizedChange: (maximized) => windows.send('main', IPC.window.maximizedChanged, maximized),
    logger: logger.child('main-window')
  });
  windows.register('main', mainWindow);

  const trayIcon = new TrayIcon({
    iconPath: icons.tray,
    platform: process.platform,
    settings,
    openMain: showMain,
    toggleQuickPanel: () => trayWindow.toggleManual(),
    quit: () => quit.quit()
  });

  const notifier = new Notifier({
    settings,
    iconPath: icons.notification,
    onClick: showMain,
    now,
    logger: logger.child('notify')
  });

  const inspect = (filePath: string) => hostClient.request('files.inspect', { path: filePath });
  const media = new MediaService({
    inspect,
    registry: core.mediaRegistry,
    identify: (file) => nodeMediaFiles.identify(file),
    statFile: async (file) => {
      const info = await stat(file).catch(() => null);
      return info?.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null;
    },
    cache: new ThumbnailCache({ dir: paths.thumbnailsDir, logger: logger.child('thumbnails') }),
    renderer: createNativeThumbnailRenderer(process.platform),
    logger: logger.child('media')
  });

  const shellService = new ShellService({ inspect, shell, dialogs: electronDialogs, settings, windowFor });
  const downloadDir = new DownloadDirDialog({
    dialogs: electronDialogs,
    settings,
    windowFor,
    setTrayDialogOpen: (open) => trayWindow.setDialogOpen(open),
    currentDownloadDir: () => lastState?.config.downloadDir ?? null,
    fallbackDir: app.getPath('downloads'),
    setDownloadDir: async (dir) => {
      const applied = await hostClient.request('settings.setDownloadDir', { path: dir });
      // Right away, not only when the next host state arrives.
      if (applied.ok) observeDownloadDir(applied.value.downloadDir);
      return applied;
    }
  });

  const tMain = () => translatorFor(settings.get().locale);
  const accounts = new OAuthAccounts({
    loginPixiv: () =>
      runPixivOAuth({
        parent: windowFor('main'),
        title: tMain().t('main.pixiv.windowTitle'),
        logger: logger.child('pixiv')
      }),
    loginSite: (vaultId) =>
      runSiteOAuth({
        siteId: vaultId as VaultSiteId,
        parent: windowFor('main'),
        title: tMain().t('main.oauth.windowTitle', { site: vaultId }),
        logger: logger.child(`oauth-${vaultId}`)
      }),
    savePixiv: (payload) => hostClient.request('accounts.pixiv.save', payload),
    clearPixiv: () => hostClient.request('accounts.pixiv.clear', {}),
    saveSite: (payload) => hostClient.request('accounts.site.save', payload),
    clearSite: (payload) => hostClient.request('accounts.site.clear', payload),
    clearPixivWebSession: clearPixivSession,
    clearSiteWebSession: (vaultId) => clearSiteOAuthSession(vaultId as VaultSiteId),
    hostReady: () => hostClient.isReady,
    vaultReady,
    logger: logger.child('accounts')
  });

  const vaultReset = new VaultResetService({
    hostVaultReady: vaultReady,
    loadKey: () => core.vault.load(),
    moveAside: () =>
      moveVaultAsideSync({ vaultDir: paths.vaultDir, keyFile: paths.vaultKeyFile }, now(), logger.child('vault')),
    restartHost: (whileStopped) => hostClient.restartWith(whileStopped),
    dialogs: electronDialogs,
    settings,
    windowFor,
    logger: logger.child('vault')
  });

  const legacyImport = new LegacyUiImporter({
    settings,
    readLegacyStorage: createLegacyStorageReader({
      userData: paths.userData,
      tempDir: paths.tempDir,
      logger: logger.child('legacy')
    }),
    importToHost: (data) => hostClient.request('legacy.importUiData', data),
    now,
    vaultReady,
    logger: logger.child('legacy')
  });

  return {
    windows,
    trayWindow,
    trayIcon,
    quit,
    notifier,
    clipboardWatcher,
    dismissed,
    media,
    shell: shellService,
    downloadDir,
    accounts,
    vaultReset,
    updater,
    legacyImport,
    showMain,
    windowFor,
    setLastState: (state) => {
      lastState = state;
      observeDownloadDir(state.config.downloadDir);
    }
  };
}
