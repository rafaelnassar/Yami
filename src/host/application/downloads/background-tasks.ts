/**
 * Tracks the background work of the downloads core (scheduling, launches,
 * supervision passes). Production only needs `track`; tests inject their own
 * instance and await `whenIdle()` to drive the core deterministically.
 */
export class BackgroundTasks {
  readonly #pending = new Set<Promise<void>>();

  track(promise: Promise<void>): void {
    this.#pending.add(promise);
    void promise.finally(() => this.#pending.delete(promise));
  }

  /** Resolves once every tracked task — including tasks queued meanwhile — has settled. */
  async whenIdle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
