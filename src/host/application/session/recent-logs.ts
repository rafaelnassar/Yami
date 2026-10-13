/**
 * `EventSink` decorator that keeps the last log entries in memory so a window
 * opened later (or reloaded) can show recent activity (`logs.recent`).
 */
import type { LogEntryDto } from '../../../shared/contracts/dto.ts';
import type { CommandResult, HostEvent } from '../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { EventSink } from '../ports/system.ts';

export const RECENT_LOGS_CAPACITY = 500;

export class RecentLogs implements EventSink {
  readonly #inner: EventSink;
  readonly #capacity: number;
  #entries: LogEntryDto[] = [];

  constructor(inner: EventSink, capacity: number = RECENT_LOGS_CAPACITY) {
    this.#inner = inner;
    this.#capacity = Math.max(1, capacity);
  }

  publish(event: HostEvent): void {
    if (event.type === 'log' && event.entries.length > 0) this.#remember(event.entries);
    this.#inner.publish(event);
  }

  /** `logs.recent` — oldest first. */
  recent(): Result<CommandResult<'logs.recent'>, AppErrorData> {
    return ok({ entries: [...this.#entries] });
  }

  #remember(entries: readonly LogEntryDto[]): void {
    const incoming = entries.length > this.#capacity ? entries.slice(-this.#capacity) : entries;
    this.#entries.push(...incoming);
    const overflow = this.#entries.length - this.#capacity;
    if (overflow > 0) this.#entries.splice(0, overflow);
  }
}
