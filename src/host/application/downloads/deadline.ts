/**
 * A single deadline shared by several awaits (host shutdown must answer main
 * within its budget whatever the OS does). Driven by the injected `TimerPort`.
 */
import type { TimerHandle, TimerPort } from './timers.ts';

export class Deadline {
  readonly #handle: TimerHandle;
  readonly #reached: Promise<null>;
  #expired = false;

  constructor(timers: TimerPort, ms: number) {
    let expire!: () => void;
    this.#reached = new Promise<null>((resolve) => {
      expire = () => resolve(null);
    });
    this.#handle = timers.schedule(ms, async () => {
      this.#expired = true;
      expire();
    });
  }

  get expired(): boolean {
    return this.#expired;
  }

  /** `{ value }` when `work` settles first, `null` when the deadline is reached first. */
  async race<T>(work: Promise<T>): Promise<{ readonly value: T } | null> {
    if (this.#expired) return null;
    return Promise.race([work.then((value) => ({ value })), this.#reached]);
  }

  /** Releases the timer (call once the guarded work is over). */
  cancel(): void {
    this.#handle.cancel();
  }
}
