/**
 * Quit sequence: the first `before-quit` is cancelled, windows disappear and background
 * work stops at once (synchronously), the host is asked to pause running downloads
 * (`lifecycle.shutdown`: the host stops engines in parallel within its own ~12 s deadline;
 * main waits ≤ 20 s, `COMMAND_SPECS`), the host process is disposed, and the app exits.
 * Every wait is bounded, so an OS logoff/shutdown is never held up indefinitely: the
 * sequence continues after the host deadline, and a custom final step that fails to end
 * the process (e.g. an installer hand-off) is followed by a forced exit. Later
 * `before-quit` events pass through.
 */
import { COMMAND_SPECS } from '../../shared/contracts/host-protocol.ts';
import { describeError, type Logger } from '../infrastructure/logger.ts';

/** Main-side `lifecycle.shutdown` timeout plus a margin for the reply and the kill. */
export const DEFAULT_HOST_SHUTDOWN_CAP_MS = COMMAND_SPECS['lifecycle.shutdown'].timeoutMs + 2_000;
/**
 * How long the final step may take to end the process before it is forced. Generous: an
 * update hand-off (`quitAndInstall`) may still be passing the update to the OS installer.
 */
export const DEFAULT_EXIT_WATCHDOG_MS = 30_000;

export interface QuitCoordinatorDeps {
  /** Synchronous, immediate: hide every window, stop pollers and timers, drop the tray… */
  readonly stopBackgroundWork: () => void;
  /** Graceful host stop (sends `lifecycle.shutdown` then kills the process). */
  readonly shutdownHost: () => Promise<void>;
  /** Default final step (`app.exit(0)`, or the quit-time update install), unless a caller provides its own. */
  readonly exit: () => void;
  /** Unconditional process exit (`app.exit(0)`), used when the final step did not end the process. */
  readonly forceExit: () => void;
  readonly logger: Logger;
  /** Hard cap in case the host never answers (the request itself times out at 20 s). */
  readonly hostTimeoutMs?: number;
  readonly exitWatchdogMs?: number;
}

type Phase = 'running' | 'stopping' | 'done';

export interface PreventableEvent {
  preventDefault(): void;
}

export class QuitCoordinator {
  readonly #deps: QuitCoordinatorDeps;
  #phase: Phase = 'running';
  #finalize: (() => void) | null = null;

  constructor(deps: QuitCoordinatorDeps) {
    this.#deps = deps;
  }

  /** True from the first quit request on: windows must stop hiding themselves on close. */
  get isQuitting(): boolean {
    return this.#phase !== 'running';
  }

  /** Wire to `app.on('before-quit')`. */
  onBeforeQuit(event: PreventableEvent): void {
    if (this.#phase === 'done') return;
    event.preventDefault();
    if (this.#phase === 'stopping') return;
    void this.#run();
  }

  /** Starts the sequence directly (tray "Quit", update install) with an optional custom final step. */
  quit(finalize?: () => void): void {
    if (finalize) this.#finalize = finalize;
    if (this.#phase !== 'running') return;
    void this.#run();
  }

  async #run(): Promise<void> {
    this.#phase = 'stopping';
    const { logger } = this.#deps;
    const startedAt = Date.now();
    logger.info('quit sequence started');
    // Runs before the first await: the app looks closed immediately.
    try {
      this.#deps.stopBackgroundWork();
    } catch (error) {
      logger.error('stopping background work failed', describeError(error));
    }
    let capTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#deps.shutdownHost(),
        new Promise<void>((resolve) => {
          capTimer = setTimeout(() => {
            logger.warn('host shutdown exceeded its cap; quitting anyway');
            resolve();
          }, this.#deps.hostTimeoutMs ?? DEFAULT_HOST_SHUTDOWN_CAP_MS);
        })
      ]);
    } catch (error) {
      logger.error('host shutdown failed', describeError(error));
    } finally {
      clearTimeout(capTimer);
    }
    this.#phase = 'done';
    logger.info('quit sequence finished', { elapsedMs: Date.now() - startedAt });
    this.#finish();
  }

  #finish(): void {
    const { logger } = this.#deps;
    // Normally the process is gone before this fires (unref: it never keeps it alive).
    setTimeout(() => {
      logger.warn('final quit step did not end the process; forcing exit');
      this.#deps.forceExit();
    }, this.#deps.exitWatchdogMs ?? DEFAULT_EXIT_WATCHDOG_MS).unref();
    const finalize = this.#finalize ?? this.#deps.exit;
    try {
      finalize();
    } catch (error) {
      logger.error('final quit step failed; exiting', describeError(error));
      this.#deps.forceExit();
    }
  }
}
