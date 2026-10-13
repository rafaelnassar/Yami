/**
 * Adaptive supervision timer: a single pending timer at a time, fast after
 * activity, backing off to `maxMs` when idle, and stopped when nothing runs
 * (zero idle CPU). `wake()` runs a pass as soon as possible (process exit).
 */
import type { TimerHandle, TimerPort } from './timers.ts';
import type { TickActivity } from './run-monitor.ts';

export interface SupervisorOptions {
  readonly minMs: number;
  readonly maxMs: number;
}

export interface TickOutcome {
  readonly activity: TickActivity;
  /** Whether anything is still running (keeps the loop alive). */
  readonly active: boolean;
}

export class Supervisor {
  readonly #timers: TimerPort;
  readonly #options: SupervisorOptions;
  readonly #runTick: () => Promise<TickOutcome>;
  #handle: TimerHandle | null = null;
  #inFlight = false;
  #wakeRequested = false;
  #keepAlive = false;
  #stopped = false;
  #interval: number;

  constructor(timers: TimerPort, options: SupervisorOptions, runTick: () => Promise<TickOutcome>) {
    this.#timers = timers;
    this.#options = options;
    this.#runTick = runTick;
    this.#interval = options.minMs;
  }

  /** Makes sure a pass is scheduled (no-op when one is pending or running). */
  ensureRunning(): void {
    if (this.#stopped || this.#handle) return;
    this.#interval = this.#options.minMs;
    // A pass in flight may have sampled "nothing running" before this new run started.
    if (this.#inFlight) this.#keepAlive = true;
    else this.#arm(this.#interval);
  }

  /** Runs a pass as soon as possible. */
  wake(): void {
    if (this.#stopped) return;
    if (this.#inFlight) {
      this.#wakeRequested = true;
      return;
    }
    this.#handle?.cancel();
    this.#handle = null;
    this.#arm(0);
  }

  stop(): void {
    this.#stopped = true;
    this.#handle?.cancel();
    this.#handle = null;
  }

  #arm(delay: number): void {
    this.#handle = this.#timers.schedule(delay, () => this.#fire());
  }

  async #fire(): Promise<void> {
    this.#handle = null;
    if (this.#stopped) return;
    this.#inFlight = true;
    let outcome: TickOutcome = { activity: 'idle', active: true };
    try {
      outcome = await this.#runTick();
    } finally {
      this.#inFlight = false;
    }
    if (this.#stopped || this.#handle) return;
    if (this.#wakeRequested) {
      this.#wakeRequested = false;
      this.#arm(0);
      return;
    }
    const keepAlive = this.#keepAlive;
    this.#keepAlive = false;
    if (!outcome.active && !keepAlive) return;
    const step = Math.max(50, Math.round((this.#options.maxMs - this.#options.minMs) / 7));
    this.#interval =
      outcome.activity === 'idle' ? Math.min(this.#options.maxMs, this.#interval + step) : this.#options.minMs;
    this.#arm(this.#interval);
  }
}
