/**
 * Composition root, part 1: process-independent services (paths, logging, settings,
 * vault key, origins, protocols, session lockdown, host client). Runs after `ready`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app, protocol, safeStorage, session } from 'electron';
import { ok } from '../../shared/kernel/result.ts';
import { MediaRegistry } from '../features/media/media-registry.ts';
import { createMediaProtocolHandler } from '../features/media/media-protocol.ts';
import { nodeMediaFiles } from '../features/media/media-files.ts';
import { buildConfigurePayload } from '../host-client/configure-payload.ts';
import { HostClient } from '../host-client/host-client.ts';
import { createUtilityHostFactory } from '../host-client/utility-host-process.ts';
import { resolveAppPaths, type AppPaths, type Platform } from '../infrastructure/app-paths.ts';
import { FileLogger } from '../infrastructure/file-logger.ts';
import { describeError, type Logger } from '../infrastructure/logger.ts';
import { ensurePrivateDirSync } from '../infrastructure/private-dir.ts';
import { SettingsStore } from '../infrastructure/settings-store.ts';
import { realTimers, type Timers } from '../infrastructure/timers.ts';
import { VaultKeyStore } from '../infrastructure/vault-key.ts';
import { createAppProtocolHandler } from '../security/app-protocol.ts';
import { APP_CSP } from '../security/csp.ts';
import { installDevServerCsp } from '../security/dev-csp.ts';
import { APP_SCHEME, AppOrigin, MEDIA_SCHEME, resolveDevServerUrl } from '../security/origins.ts';
import { lockDownSession } from '../security/permissions.ts';

export interface CoreServices {
  readonly bundleDir: string;
  readonly platform: Platform;
  readonly paths: AppPaths;
  readonly logger: Logger;
  readonly settings: SettingsStore;
  readonly vault: VaultKeyStore;
  readonly origin: AppOrigin;
  readonly mediaRegistry: MediaRegistry;
  readonly hostClient: HostClient;
  /** Whether the last `system.configure` carried a vault key (false: the host's vault is disabled). */
  readonly hostVaultReady: () => boolean;
  readonly timers: Timers;
  readonly now: () => number;
}

export function normalizePlatform(platform: NodeJS.Platform): Platform {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}

async function readAsset(file: string): Promise<Uint8Array | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Makes `paths.tempDir` private before main or the host writes anything there. */
function withPrivateTempDir(paths: AppPaths, platform: Platform, logger: Logger): AppPaths {
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const tempDir = ensurePrivateDirSync(paths.tempDir, { platform, uid, logger });
    return tempDir === paths.tempDir ? paths : { ...paths, tempDir };
  } catch (error) {
    // userData itself is unusable: users of the temp dir will fail and report it.
    logger.error('could not prepare the temp dir', describeError(error));
    return paths;
  }
}

export function createCoreServices(bundleDir: string): CoreServices {
  const platform = normalizePlatform(process.platform);
  const resolved = resolveAppPaths({
    platform,
    userData: app.getPath('userData'),
    logs: app.getPath('logs'),
    home: app.getPath('home'),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    env: process.env,
    exists: existsSync
  });
  const logger = new FileLogger({
    dir: resolved.logsDir,
    sensitiveDirs: [resolved.vaultDir, path.join(resolved.dataDir, 'work')],
    echo: !app.isPackaged
  });
  const paths = withPrivateTempDir(resolved, platform, logger.child('paths'));
  const timers = realTimers;
  const now = Date.now;
  const settings = new SettingsStore(paths.settingsFile, logger.child('settings'));
  const vault = new VaultKeyStore(paths.vaultKeyFile, safeStorage, process.platform, logger.child('vault'));
  const origin = new AppOrigin(resolveDevServerUrl({ isPackaged: app.isPackaged, env: process.env }));

  // Protocols live on the default session (the only session app windows use).
  protocol.handle(
    APP_SCHEME,
    createAppProtocolHandler({
      rootDir: path.join(app.getAppPath(), 'dist', 'renderer'),
      csp: APP_CSP,
      readFile: readAsset
    })
  );
  const mediaRegistry = new MediaRegistry({ now });
  protocol.handle(MEDIA_SCHEME, createMediaProtocolHandler(mediaRegistry, nodeMediaFiles));

  const isAppUrl = (url: string): boolean => origin.isAppUrl(url);
  lockDownSession(session.defaultSession, isAppUrl);
  // Dev only: the Vite server sends no CSP (production gets APP_CSP from the app: handler).
  if (origin.isDevServer) installDevServerCsp(session.defaultSession, origin);
  app.on('session-created', (created) => lockDownSession(created, isAppUrl));

  let hostVaultReady = false;
  const hostClient = new HostClient({
    spawn: createUtilityHostFactory({ modulePath: path.join(bundleDir, 'host.cjs'), logger: logger.child('host') }),
    // An unloadable vault key degrades the host (disabled vault) instead of keeping it offline.
    configure: async () => {
      const payload = buildConfigurePayload({
        paths,
        loadVaultKey: () => vault.load(),
        defaultDownloadDir: path.join(app.getPath('downloads'), 'Yami'),
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
        logger: logger.child('vault')
      });
      hostVaultReady = payload.vaultKey !== null;
      return ok(payload);
    },
    timers,
    now,
    logger: logger.child('host-client')
  });

  logger.info('main started', {
    version: app.getVersion(),
    platform,
    packaged: app.isPackaged,
    devServer: origin.isDevServer
  });
  return {
    bundleDir,
    platform,
    paths,
    logger,
    settings,
    vault,
    origin,
    mediaRegistry,
    hostClient,
    hostVaultReady: () => hostVaultReady,
    timers,
    now
  };
}
