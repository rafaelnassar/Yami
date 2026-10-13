/** Deterministic `Scheduler` for unit tests: time only moves when `advance()` is called. */
import type { Scheduler } from '../lib/scheduler.ts';

interface Pending {
  readonly id: number;
  readonly at: number;
  readonly task: () => void;
}

export interface ManualScheduler extends Scheduler {
  advance(ms: number): void;
  flushFrames(): void;
  readonly pendingCount: number;
}

export function createManualScheduler(start = 1_000): ManualScheduler {
  let now = start;
  let seq = 0;
  let timers: Pending[] = [];
  let frames: Pending[] = [];

  return {
    delay(task, ms) {
      const entry = { id: ++seq, at: now + ms, task };
      timers.push(entry);
      return () => {
        timers = timers.filter((item) => item.id !== entry.id);
      };
    },
    frame(task) {
      const entry = { id: ++seq, at: now, task };
      frames.push(entry);
      return () => {
        frames = frames.filter((item) => item.id !== entry.id);
      };
    },
    now: () => now,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = timers.filter((item) => item.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        timers = timers.filter((item) => item.id !== next.id);
        now = next.at;
        next.task();
      }
      now = target;
    },
    flushFrames() {
      const current = frames;
      frames = [];
      for (const entry of current) entry.task();
    },
    get pendingCount() {
      return timers.length + frames.length;
    }
  };
}
