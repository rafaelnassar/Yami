/**
 * App auto-update (electron-updater, GitHub Releases). Disabled in development and — for
 * automatic checks — when `settings.autoUpdate` is off (manual checks still work then).
 * Checks 30 s after start and every 6 h; downloads automatically; `install()` runs the
 * normal shutdown sequence before `quitAndInstall`.
 *
 * electron-updater can only replace NSIS installs, so the portable build runs check-only:
 * the `manual` status reports a newer release, which the user downloads from
 * `RELEASES_URL` (opened through the validated `shell.openExternal` flow). Nothing is ever
 * downloaded or installed there.
 */
import type { UpdateStatus } from '../../../shared/contracts/ipc.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { describeError, type Logger } from '../../infrastructure/logger.ts';
import type { Cancel, Timers } from '../../infrastructure/timers.ts';

/** The part of electron-updater's `autoUpdater` used here. */
export interface UpdaterEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(
    event: 'update-available' | 'update-not-available' | 'update-downloaded',
    listener: (info: { readonly version: string }) => void
  ): unknown;
  on(event: 'download-progress', listener: (progress: { readonly percent: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

type ManualStatus = Extract<UpdateStatus, { state: 'manual' }>;

const MANUAL_INITIAL: ManualStatus = { state: 'manual', version: null, checkedAt: null, checking: false, error: null };

/** electron-builder's portable launcher sets these for the app it extracts and runs. */
export function isPortableBuild(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env['PORTABLE_EXECUTABLE_FILE'] || env['PORTABLE_EXECUTABLE_DIR']);
}

export interface UpdaterDeps {
  readonly isPackaged: boolean;
  /** Portable build (`isPortableBuild`): check-only, see the module comment. */
  readonly isPortable: boolean;
  readonly autoUpdateEnabled: () => boolean;
  readonly loadEngine: () => Promise<UpdaterEngine | null>;
  /** Runs the app shutdown sequence, then calls `finalize` instead of a plain exit. */
  readonly quitWith: (finalize: () => void) => void;
  readonly timers: Timers;
  readonly now: () => number;
  readonly logger: Logger;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
}

export class Updater {
  readonly #deps: UpdaterDeps;
  /** Check-only mode (portable build): never downloads nor installs. */
  readonly #manual: boolean;
  readonly #listeners = new Set<(status: UpdateStatus) => void>();
  #status: UpdateStatus;
  #engine: UpdaterEngine | null = null;
  #engineLoad: Promise<UpdaterEngine | null> | null = null;
  #engineMissing = false;
  #cancelSchedule: Cancel[] = [];
  #checkedAt: number | null = null;

  constructor(deps: UpdaterDeps) {
    this.#deps = deps;
    this.#manual = deps.isPackaged && deps.isPortable;
    this.#status = this.#initialStatus();
  }

  get status(): UpdateStatus {
    return this.#status;
  }

  get hasPendingInstall(): boolean {
    return this.#status.state === 'ready';
  }

  onStatus(listener: (status: UpdateStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** (Re)applies the schedule; call at startup and whenever `autoUpdate` changes. */
  refreshSchedule(): void {
    for (const cancel of this.#cancelSchedule) cancel();
    this.#cancelSchedule = [];
    if (!this.#supported()) return;
    if (!this.#deps.autoUpdateEnabled()) {
      // The portable build keeps its `manual` status: only the automatic checks stop.
      if (!this.#manual && this.#isIdle()) this.#set({ state: 'disabled', reason: 'setting' });
      return;
    }
    if (this.#status.state === 'disabled') this.#set({ state: 'idle', checkedAt: this.#checkedAt });
    const run = (): void => void this.check();
    this.#cancelSchedule.push(this.#deps.timers.schedule(run, this.#deps.initialDelayMs ?? 30_000));
    this.#cancelSchedule.push(this.#deps.timers.every(run, this.#deps.intervalMs ?? 6 * 60 * 60_000));
  }

  async check(): Promise<Result<UpdateStatus, AppErrorData>> {
    if (!this.#supported()) return err(appError(ErrorCode.UPDATE_UNAVAILABLE));
    if (this.#busy()) return ok(this.#status);
    const engine = await this.#loadEngine();
    if (!engine) return err(appError(ErrorCode.UPDATE_UNAVAILABLE));
    try {
      await engine.checkForUpdates();
    } catch (error) {
      this.#deps.logger.warn('update check failed', describeError(error));
      this.#fail(error);
    }
    // A check that ends without a result event must not leave the portable status spinning.
    if (this.#status.state === 'manual' && this.#status.checking) this.#setManual({ checking: false });
    return ok(this.#status);
  }

  install(): Result<null, AppErrorData> {
    const engine = this.#engine;
    if (this.#manual || !engine || this.#status.state !== 'ready') return err(appError(ErrorCode.UPDATE_UNAVAILABLE));
    this.#deps.quitWith(() => engine.quitAndInstall(false, true));
    return ok(null);
  }

  /** Quit-time install of an already downloaded update (replaces `autoInstallOnAppQuit`). */
  installOnQuit(): boolean {
    if (this.#manual || !this.#engine || this.#status.state !== 'ready') return false;
    this.#engine.quitAndInstall(true, false);
    return true;
  }

  dispose(): void {
    for (const cancel of this.#cancelSchedule) cancel();
    this.#cancelSchedule = [];
  }

  /** Dev builds and a missing electron-updater can never check (the setting only gates automatic checks). */
  #supported(): boolean {
    return this.#deps.isPackaged && !this.#engineMissing;
  }

  #initialStatus(): UpdateStatus {
    if (!this.#deps.isPackaged) return { state: 'disabled', reason: 'dev' };
    if (this.#manual) return MANUAL_INITIAL;
    if (!this.#deps.autoUpdateEnabled()) return { state: 'disabled', reason: 'setting' };
    return { state: 'idle', checkedAt: null };
  }

  #busy(): boolean {
    const status = this.#status;
    if (status.state === 'manual') return status.checking;
    return status.state === 'checking' || status.state === 'downloading' || status.state === 'ready';
  }

  #isIdle(): boolean {
    return this.#status.state === 'idle' || this.#status.state === 'error' || this.#status.state === 'disabled';
  }

  #loadEngine(): Promise<UpdaterEngine | null> {
    this.#engineLoad ??= this.#deps.loadEngine().then((engine) => {
      if (!engine) {
        this.#engineMissing = true;
        if (this.#manual) this.#setManual({ checking: false, error: appError(ErrorCode.UPDATE_UNAVAILABLE) });
        else this.#set({ state: 'disabled', reason: 'unsupported' });
        return null;
      }
      // The portable build only looks for new versions: electron-updater cannot replace it.
      engine.autoDownload = !this.#manual;
      // Quit-time installs go through our shutdown sequence (see `installOnQuit`).
      engine.autoInstallOnAppQuit = false;
      engine.on('checking-for-update', () => {
        if (this.#manual) this.#setManual({ checking: true, error: null });
        else this.#set({ state: 'checking' });
      });
      engine.on('update-available', (info) => {
        if (!this.#manual) {
          this.#set({ state: 'available', version: info.version });
          return;
        }
        this.#checkedAt = this.#deps.now();
        this.#setManual({ version: info.version, checkedAt: this.#checkedAt, checking: false, error: null });
      });
      engine.on('update-not-available', () => {
        this.#checkedAt = this.#deps.now();
        if (this.#manual) this.#setManual({ version: null, checkedAt: this.#checkedAt, checking: false, error: null });
        else this.#set({ state: 'idle', checkedAt: this.#checkedAt });
      });
      engine.on('download-progress', (progress) => {
        if (this.#manual) return;
        const version = ('version' in this.#status ? this.#status.version : null) ?? '';
        this.#set({ state: 'downloading', version, percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
      });
      engine.on('update-downloaded', (info) => {
        // Unreachable with `autoDownload` off; never offer an install the portable build cannot perform.
        if (this.#manual) return;
        this.#set({ state: 'ready', version: info.version });
      });
      engine.on('error', (error) => this.#fail(error));
      this.#engine = engine;
      return engine;
    });
    return this.#engineLoad;
  }

  #fail(error: unknown): void {
    const detail =
      error instanceof Error ? (error.message.split('\n')[0]?.slice(0, 200) ?? '') : String(error).slice(0, 200);
    const failure = appError(ErrorCode.UPDATE_FAILED, { detail });
    if (this.#manual) this.#setManual({ checking: false, error: failure });
    else this.#set({ state: 'error', error: failure });
  }

  #setManual(patch: Partial<Omit<ManualStatus, 'state'>>): void {
    const current = this.#status.state === 'manual' ? this.#status : MANUAL_INITIAL;
    this.#set({ ...current, ...patch });
  }

  #set(status: UpdateStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) {
      try {
        listener(status);
      } catch (error) {
        this.#deps.logger.error('update status listener failed', describeError(error));
      }
    }
  }
}
