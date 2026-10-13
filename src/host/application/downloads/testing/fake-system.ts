/**
 * Fake cross-cutting ports: event sink, logger, clock and timers.
 */
import type { Clock } from '../../../../shared/kernel/clock.ts';
import type { LogEntryDto } from '../../../../shared/contracts/dto.ts';
import type { HostEvent, HostEventType } from '../../../../shared/contracts/host-protocol.ts';
import type { EventSink, LogFields, Logger } from '../../ports/system.ts';
import type { TimerHandle, TimerPort } from '../timers.ts';

export class RecordingEventSink implements EventSink {
  readonly events: HostEvent[] = [];

  publish(event: HostEvent): void {
    this.events.push(event);
  }

  ofType<T extends HostEventType>(type: T): Extract<HostEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<HostEvent, { type: T }> => event.type === type);
  }

  logs(): LogEntryDto[] {
    return this.ofType('log').flatMap((event) => event.entries);
  }

  /** Every text a user could see in published events (logs, notices), for leak checks. */
  publishedText(): string {
    return JSON.stringify(this.events);
  }

  clear(): void {
    this.events.length = 0;
  }
}

export interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

export class RecordingLogger implements Logger {
  readonly records: LogRecord[];

  constructor(records: LogRecord[] = []) {
    this.records = records;
  }

  debug(message: string, fields?: LogFields): void {
    this.records.push({ level: 'debug', message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.records.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.records.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.records.push({ level: 'error', message, fields });
  }
  child(): Logger {
    return new RecordingLogger(this.records);
  }
}

export class ManualClock implements Clock {
  #now: number;

  constructor(start = 1_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  set(time: number): void {
    this.#now = Math.max(this.#now, time);
  }
}

interface ScheduledTimer {
  readonly seq: number;
  readonly due: number;
  readonly callback: () => Promise<void>;
  cancelled: boolean;
}

/** Timers fired explicitly by the test; firing advances the shared clock to the due time. */
export class ManualTimers implements TimerPort {
  readonly #clock: ManualClock;
  readonly #queue: ScheduledTimer[] = [];
  #seq = 0;
  readonly delays: number[] = [];

  constructor(clock: ManualClock) {
    this.#clock = clock;
  }

  schedule(delayMs: number, callback: () => Promise<void>): TimerHandle {
    const timer: ScheduledTimer = { seq: this.#seq++, due: this.#clock.now() + delayMs, callback, cancelled: false };
    this.delays.push(delayMs);
    this.#queue.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      }
    };
  }

  get pending(): number {
    return this.#queue.filter((timer) => !timer.cancelled).length;
  }

  /** Fires the earliest pending timer and waits for its callback. Returns false when none is pending. */
  async runNext(): Promise<boolean> {
    const live = this.#queue.filter((timer) => !timer.cancelled).sort((a, b) => a.due - b.due || a.seq - b.seq);
    const next = live[0];
    this.#queue.length = 0;
    this.#queue.push(...live.slice(1));
    if (!next) return false;
    this.#clock.set(next.due);
    await next.callback();
    return true;
  }
}
