/**
 * Electron glue for the launch smoke test (`src/main/app/smoke-test.ts`): sandboxing the
 * per-user paths before `ready`, and wiring the checks to the real window and host client.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, type BrowserWindow, type WebContents } from 'electron';
import {
  RENDERER_PROBE_SCRIPT,
  SMOKE_RESULT_FILE,
  runSmokeTest,
  smokeSandbox,
  toRendererProbe,
  type SmokeOptions
} from '../app/smoke-test.ts';
import type { HostClient } from '../host-client/host-client.ts';
import type { Logger } from '../infrastructure/logger.ts';
import type { Timers } from '../infrastructure/timers.ts';

export interface ActiveSmoke {
  readonly root: string;
}

/**
 * Points every per-user path (and the environment the app and its children read) into the
 * sandbox. Runs before `ready` and before the single-instance lock, so a smoke run is its own
 * instance and never sees the user's profile. Throws when a path cannot be redirected: the
 * caller must then exit instead of running against real data.
 */
export function applySmokeSandbox(options: SmokeOptions): ActiveSmoke {
  const root = options.dir ? path.resolve(options.dir) : mkdtempSync(path.join(os.tmpdir(), 'yami-smoke-'));
  const sandbox = smokeSandbox(root, app.getName());
  for (const dir of [...Object.values(sandbox.paths), ...Object.values(sandbox.env)])
    mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(sandbox.env)) process.env[name] = value;
  process.env['HOME'] = sandbox.paths.home;
  if (process.platform === 'win32') {
    // Read by the host/engines (browser cookie stores, gallery-dl's default cache) through the environment.
    process.env['USERPROFILE'] = sandbox.paths.home;
    process.env['APPDATA'] = sandbox.paths.appData;
  }
  // Not sandboxed: `safeStorage` on macOS/Linux uses the user's real keychain/keyring entry for the app (it may
  // prompt or create it). CI runs the smoke test on Windows, where DPAPI keeps no state.
  app.setPath('home', sandbox.paths.home);
  app.setPath('appData', sandbox.paths.appData);
  app.setPath('userData', sandbox.paths.userData);
  app.setPath('downloads', sandbox.paths.downloads);
  app.setAppLogsPath(sandbox.paths.logs);
  return { root: sandbox.root };
}

function mainFrameLoaded(contents: WebContents): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!contents.isLoadingMainFrame() && contents.getURL() !== '') {
      resolve();
      return;
    }
    contents.once('did-finish-load', () => resolve());
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) reject(new Error(`${description} (${code}) ${url}`));
    });
  });
}

export interface SmokeWiring {
  readonly window: BrowserWindow | null;
  readonly hostClient: HostClient;
  readonly timers: Timers;
  readonly now: () => number;
  readonly logger: Logger;
  /** Normal quit sequence with a custom final step (`QuitCoordinator.quit`). */
  readonly quitWith: (finalize: () => void) => void;
}

export function startSmokeTest(active: ActiveSmoke, wiring: SmokeWiring): void {
  const { window, logger } = wiring;
  const contents = window && !window.isDestroyed() ? window.webContents : null;
  logger.info('smoke test started', { root: active.root });
  runSmokeTest({
    rendererLoaded: () => (contents ? mainFrameLoaded(contents) : Promise.reject(new Error('no main window'))),
    probeRenderer: async () => {
      if (!contents || contents.isDestroyed()) return { bridge: false, mounted: false, crashed: false };
      return toRendererProbe(await contents.executeJavaScript(RENDERER_PROBE_SCRIPT, false));
    },
    hostStatus: () => wiring.hostClient.status,
    onHostStatus: (listener) => wiring.hostClient.onStatus(listener),
    onRendererGone: (listener) => {
      if (!contents) return () => undefined;
      const onGone = (_event: unknown, details: { reason: string }): void => listener(details.reason);
      contents.on('render-process-gone', onGone);
      return () => {
        if (!contents.isDestroyed()) contents.off('render-process-gone', onGone);
      };
    },
    timers: wiring.timers,
    now: wiring.now,
    logger,
    report: (result) => {
      try {
        writeFileSync(path.join(active.root, SMOKE_RESULT_FILE), `${JSON.stringify(result)}\n`);
      } catch (error) {
        logger.warn('could not write the smoke result file', { error: String(error) });
      }
    },
    pass: () => wiring.quitWith(() => app.exit(0)),
    fail: () => app.exit(1)
  });
}
