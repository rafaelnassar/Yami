/** Timer abstraction so time-driven logic (backoff, polling, TTLs) is testable with fakes. */

export type Cancel = () => void;

export interface Timers {
  /** Runs `fn` once after `ms`; the returned function cancels it. */
  schedule(fn: () => void, ms: number): Cancel;
  /** Runs `fn` every `ms`; the returned function stops it. */
  every(fn: () => void, ms: number): Cancel;
}

export const realTimers: Timers = {
  schedule(fn, ms) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  every(fn, ms) {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  }
};
