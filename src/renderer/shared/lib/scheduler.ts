/**
 * Timer abstraction injected into stores so debouncing/coalescing is testable
 * without real timers or `requestAnimationFrame`.
 */
export type Cancel = () => void;

export interface Scheduler {
  /** Runs `task` after `ms` milliseconds. */
  readonly delay: (task: () => void, ms: number) => Cancel;
  /** Runs `task` before the next paint (coalesces bursts of events into one render). */
  readonly frame: (task: () => void) => Cancel;
  readonly now: () => number;
}

export const browserScheduler: Scheduler = {
  delay(task, ms) {
    const id = globalThis.setTimeout(task, ms);
    return () => globalThis.clearTimeout(id);
  },
  frame(task) {
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      const id = globalThis.setTimeout(task, 16);
      return () => globalThis.clearTimeout(id);
    }
    const id = globalThis.requestAnimationFrame(() => task());
    return () => globalThis.cancelAnimationFrame(id);
  },
  now: () => Date.now()
};

/** Debounced trigger: repeated calls within `ms` collapse into a single `task` run. */
export function createDebounced(
  scheduler: Scheduler,
  task: () => void,
  ms: number
): { trigger(): void; cancel(): void } {
  let cancel: Cancel | null = null;
  return {
    trigger() {
      cancel?.();
      cancel = scheduler.delay(() => {
        cancel = null;
        task();
      }, ms);
    },
    cancel() {
      cancel?.();
      cancel = null;
    }
  };
}
