/**
 * Minimal timer abstraction for the supervision loop, so tests can drive ticks
 * deterministically (see `testing/manual-timers.ts`).
 */

export interface TimerHandle {
  cancel(): void;
}

export interface TimerPort {
  /** Runs `callback` once after `delayMs`. The returned promise of the callback is not awaited. */
  schedule(delayMs: number, callback: () => Promise<void>): TimerHandle;
}

export const realTimers: TimerPort = {
  schedule(delayMs, callback) {
    const timer = setTimeout(() => {
      void callback();
    }, delayMs);
    // Never keep the host process alive just for supervision.
    (timer as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(timer) };
  }
};
