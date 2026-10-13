/**
 * Launch smoke test for packaged builds: `Yami --yami-smoke-test[=<dir>]` (CI runs it on the
 * unpacked app produced by `npm run pack`).
 *
 * Before anything else starts, every special path the app writes to (home, appData, userData,
 * logs, downloads, LOCALAPPDATA / XDG_*) is redirected into a sandbox directory, so a smoke run
 * never touches the user's settings, history, vault, managed tools or the legacy `~/.yami`.
 * The run passes once the main window's renderer has mounted with the preload bridge *and* the
 * host reported `ready`; it then goes through the normal quit sequence and exits 0. A load
 * failure, renderer crash, host crash/offline or the timeout exits 1 right away.
 */
import path from 'node:path';
import type { HostConnectionStatus } from '../../shared/contracts/ipc.ts';
import type { Logger } from '../infrastructure/logger.ts';
import type { Timers } from '../infrastructure/timers.ts';

export const SMOKE_FLAG = '--yami-smoke-test';
export const SMOKE_TIMEOUT_MS = 90_000;
export const SMOKE_RESULT_FILE = 'smoke-result.json';
const PROBE_INTERVAL_MS = 250;

export interface SmokeOptions {
  /** Sandbox root from `--yami-smoke-test=<dir>`; `null` → a fresh temporary directory. */
  readonly dir: string | null;
}

/** Finds `--yami-smoke-test` / `--yami-smoke-test=<dir>` in argv; `null` when absent. */
export function parseSmokeFlag(argv: readonly string[]): SmokeOptions | null {
  for (const arg of argv) {
    if (arg === SMOKE_FLAG) return { dir: null };
    if (arg.startsWith(`${SMOKE_FLAG}=`)) {
      const dir = arg.slice(SMOKE_FLAG.length + 1).trim();
      return { dir: dir.length > 0 ? dir : null };
    }
  }
  return null;
}

export type SmokePathName = 'home' | 'appData' | 'userData' | 'logs' | 'downloads';

export interface SmokeSandbox {
  readonly root: string;
  /** Values for `app.setPath` (`logs` goes through `app.setAppLogsPath`). */
  readonly paths: Readonly<Record<SmokePathName, string>>;
  /** Environment overrides read by `app-paths.ts` (managed tools directory). */
  readonly env: Readonly<Record<'LOCALAPPDATA' | 'XDG_DATA_HOME' | 'XDG_CONFIG_HOME', string>>;
}

/** Pure layout of the sandbox; mirrors the real per-user layout under `root`. */
export function smokeSandbox(root: string, productName: string): SmokeSandbox {
  const resolved = path.resolve(root);
  const appData = path.join(resolved, 'AppData', 'Roaming');
  return {
    root: resolved,
    paths: {
      home: path.join(resolved, 'home'),
      appData,
      userData: path.join(appData, productName),
      logs: path.join(resolved, 'logs'),
      downloads: path.join(resolved, 'home', 'Downloads')
    },
    env: {
      LOCALAPPDATA: path.join(resolved, 'AppData', 'Local'),
      XDG_DATA_HOME: path.join(resolved, 'home', '.local', 'share'),
      XDG_CONFIG_HOME: path.join(resolved, 'home', '.config')
    }
  };
}

export interface RendererProbe {
  /** `window.yami` exists (the sandboxed preload ran and the context bridge works). */
  readonly bridge: boolean;
  /** React rendered something into `#root` (the bundle loaded under the CSP). */
  readonly mounted: boolean;
  /** An ErrorBoundary fallback is on screen (`data-yami-error-boundary`): a panel crashed while rendering. */
  readonly crashed: boolean;
}

/** Script evaluated in the main window by `probeRenderer`. */
export const RENDERER_PROBE_SCRIPT = [
  '({',
  "bridge: typeof window.yami === 'object' && window.yami !== null,",
  "mounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,",
  "crashed: document.querySelector('[data-yami-error-boundary]') !== null",
  '})'
].join(' ');

/** Validates what `executeJavaScript(RENDERER_PROBE_SCRIPT)` returned. */
export function toRendererProbe(value: unknown): RendererProbe {
  if (typeof value !== 'object' || value === null) return { bridge: false, mounted: false, crashed: false };
  return {
    bridge: Reflect.get(value, 'bridge') === true,
    mounted: Reflect.get(value, 'mounted') === true,
    crashed: Reflect.get(value, 'crashed') === true
  };
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly elapsedMs: number;
}

export interface SmokeRunDeps {
  /** Resolves once the main window finished loading; rejects when the main frame failed to load. */
  readonly rendererLoaded: () => Promise<void>;
  readonly probeRenderer: () => Promise<RendererProbe>;
  readonly hostStatus: () => HostConnectionStatus;
  readonly onHostStatus: (listener: (status: HostConnectionStatus) => void) => () => void;
  readonly onRendererGone: (listener: (reason: string) => void) => () => void;
  readonly timers: Timers;
  readonly now: () => number;
  readonly logger: Logger;
  /** Records the result (CI reads `smoke-result.json`). Must not throw. */
  readonly report: (result: SmokeResult) => void;
  /** Success: normal quit sequence, then exit 0. */
  readonly pass: () => void;
  /** Failure: immediate exit 1. */
  readonly fail: () => void;
  readonly timeoutMs?: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function describeStatus(status: HostConnectionStatus): string {
  if (status.state === 'offline' || status.state === 'restarting') {
    return `host ${status.state}${status.error ? ` (${status.error.code})` : ''}`;
  }
  return `host ${status.state}`;
}

/** Starts the checks; exactly one of `pass` / `fail` is called. */
export function runSmokeTest(deps: SmokeRunDeps): void {
  const startedAt = deps.now();
  const logger = deps.logger;
  let settled = false;
  let hostReady = false;
  let rendererReady = false;
  const cleanups: Array<() => void> = [];

  const settle = (ok: boolean, reason: string | null): void => {
    if (settled) return;
    settled = true;
    for (const cleanup of cleanups) cleanup();
    const result: SmokeResult = { ok, reason, elapsedMs: deps.now() - startedAt };
    if (ok) logger.info('smoke test passed', { elapsedMs: result.elapsedMs });
    else logger.error('smoke test failed', { reason, elapsedMs: result.elapsedMs });
    deps.report(result);
    if (ok) deps.pass();
    else deps.fail();
  };
  const maybePass = (): void => {
    if (hostReady && rendererReady) settle(true, null);
  };
  const onStatus = (status: HostConnectionStatus): void => {
    if (status.state === 'ready') {
      hostReady = true;
      maybePass();
    } else if (status.state === 'offline' || status.state === 'restarting') {
      // A host that crashes or gives up during startup is exactly what the smoke test must catch.
      settle(false, describeStatus(status));
    }
  };

  const timeoutMs = deps.timeoutMs ?? SMOKE_TIMEOUT_MS;
  cleanups.push(
    deps.timers.schedule(() => {
      const pending = [
        hostReady ? null : describeStatus(deps.hostStatus()),
        rendererReady ? null : 'renderer not ready'
      ];
      settle(false, `timeout after ${timeoutMs} ms: ${pending.filter((item) => item !== null).join(', ')}`);
    }, timeoutMs)
  );
  cleanups.push(deps.onRendererGone((reason) => settle(false, `renderer process gone (${reason})`)));
  cleanups.push(deps.onHostStatus(onStatus));
  onStatus(deps.hostStatus());

  const probeUntilMounted = (): void => {
    if (settled) return;
    deps
      .probeRenderer()
      .then((probe) => {
        if (settled) return;
        if (probe.crashed) {
          settle(false, 'renderer shows an error boundary (a panel crashed while rendering)');
          return;
        }
        if (probe.bridge && probe.mounted) {
          rendererReady = true;
          maybePass();
          return;
        }
        cleanups.push(deps.timers.schedule(probeUntilMounted, PROBE_INTERVAL_MS));
      })
      .catch((error: unknown) => settle(false, `renderer probe failed: ${messageOf(error)}`));
  };
  deps
    .rendererLoaded()
    .then(probeUntilMounted)
    .catch((error: unknown) => settle(false, `renderer failed to load: ${messageOf(error)}`));
}
