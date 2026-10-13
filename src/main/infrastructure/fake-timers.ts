/** Test support: deterministic `Timers` implementation. */
import type { Cancel, Timers } from './timers.ts';

/** Deterministic timers for tests: time only moves when `advance()` is called. */
export class FakeTimers implements Timers {
  #now = 0;
  #seq = 0;
  readonly #tasks = new Map<number, { at: number; fn: () => void; every: number | null }>();

  get now(): number {
    return this.#now;
  }

  get pending(): number {
    return this.#tasks.size;
  }

  schedule(fn: () => void, ms: number): Cancel {
    return this.#add(fn, ms, null);
  }

  every(fn: () => void, ms: number): Cancel {
    return this.#add(fn, ms, ms);
  }

  /** Moves time forward, running due tasks in order (including tasks they schedule). */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of this.#tasks) {
        if (task.at <= target && task.at < nextAt) {
          nextAt = task.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const task = this.#tasks.get(nextId);
      if (!task) break;
      this.#now = task.at;
      if (task.every === null) this.#tasks.delete(nextId);
      else task.at += task.every;
      task.fn();
    }
    this.#now = target;
  }

  #add(fn: () => void, ms: number, every: number | null): Cancel {
    const id = (this.#seq += 1);
    this.#tasks.set(id, { at: this.#now + Math.max(0, ms), fn, every: every === null ? null : Math.max(1, every) });
    return () => {
      this.#tasks.delete(id);
    };
  }
}
