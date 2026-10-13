/**
 * Publishes host events to main with flow control:
 * - `state`: latest-wins, at most one per `stateIntervalMs` (UI stays smooth, IPC stays cheap);
 * - `log` / `files.added`: merged into batches (`logIntervalMs` / `filesIntervalMs`, capped sizes);
 * - everything else: sent immediately, after flushing pending batches so causality is kept
 *   (e.g. the files of a download reach the UI before its `download.finished`).
 */
import type { HostEvent, HostToMainMessage } from '../../shared/contracts/host-protocol.ts';
import type { LogEntryDto, MediaFileDto } from '../../shared/contracts/dto.ts';
import type { EventSink } from '../application/ports/system.ts';

export interface EventDispatcherOptions {
  readonly stateIntervalMs: number;
  readonly logIntervalMs: number;
  readonly filesIntervalMs: number;
  readonly maxBatch: number;
}

export const DEFAULT_DISPATCHER_OPTIONS: EventDispatcherOptions = {
  stateIntervalMs: 250,
  logIntervalMs: 100,
  filesIntervalMs: 75,
  maxBatch: 200
};

export interface DispatcherTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: DispatcherTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
};

type StateEvent = Extract<HostEvent, { type: 'state' }>;

export class EventDispatcher implements EventSink {
  readonly #send: (message: HostToMainMessage) => void;
  readonly #options: EventDispatcherOptions;
  readonly #timers: DispatcherTimers;
  #pendingState: StateEvent | null = null;
  #stateTimer: unknown = null;
  #lastStateAt = Number.NEGATIVE_INFINITY;
  #logs: LogEntryDto[] = [];
  #logTimer: unknown = null;
  #files: MediaFileDto[] = [];
  #filesTimer: unknown = null;
  #closed = false;

  constructor(
    send: (message: HostToMainMessage) => void,
    options: EventDispatcherOptions = DEFAULT_DISPATCHER_OPTIONS,
    timers: DispatcherTimers = realTimers
  ) {
    this.#send = send;
    this.#options = options;
    this.#timers = timers;
  }

  publish(event: HostEvent): void {
    if (this.#closed) return;
    switch (event.type) {
      case 'state':
        this.#queueState(event);
        return;
      case 'log':
        // Loop instead of push(...spread): huge batches (log drains) would overflow the call stack.
        for (const entry of event.entries) this.#logs.push(entry);
        if (this.#logs.length >= this.#options.maxBatch) this.#flushLogs();
        else this.#logTimer ??= this.#timers.setTimeout(() => this.#flushLogs(), this.#options.logIntervalMs);
        return;
      case 'files.added':
        for (const item of event.items) this.#files.push(item);
        if (this.#files.length >= this.#options.maxBatch) this.#flushFiles();
        else this.#filesTimer ??= this.#timers.setTimeout(() => this.#flushFiles(), this.#options.filesIntervalMs);
        return;
      default:
        this.#flushFiles();
        this.#flushLogs();
        this.#emit(event);
    }
  }

  /** Sends everything pending right away (shutdown, tests). */
  flush(): void {
    this.#flushFiles();
    this.#flushLogs();
    this.#flushState();
  }

  close(): void {
    this.flush();
    this.#closed = true;
  }

  #queueState(event: StateEvent): void {
    this.#pendingState = event;
    if (this.#stateTimer !== null) return;
    const wait = Math.max(0, this.#lastStateAt + this.#options.stateIntervalMs - this.#timers.now());
    if (wait === 0) {
      this.#flushState();
      return;
    }
    this.#stateTimer = this.#timers.setTimeout(() => this.#flushState(), wait);
  }

  #flushState(): void {
    if (this.#stateTimer !== null) this.#timers.clearTimeout(this.#stateTimer);
    this.#stateTimer = null;
    const event = this.#pendingState;
    if (!event) return;
    this.#pendingState = null;
    this.#lastStateAt = this.#timers.now();
    this.#emit(event);
  }

  #flushLogs(): void {
    if (this.#logTimer !== null) this.#timers.clearTimeout(this.#logTimer);
    this.#logTimer = null;
    while (this.#logs.length > 0) {
      this.#emit({ type: 'log', entries: this.#logs.splice(0, this.#options.maxBatch) });
    }
  }

  #flushFiles(): void {
    if (this.#filesTimer !== null) this.#timers.clearTimeout(this.#filesTimer);
    this.#filesTimer = null;
    while (this.#files.length > 0) {
      this.#emit({ type: 'files.added', items: this.#files.splice(0, this.#options.maxBatch) });
    }
  }

  #emit(event: HostEvent): void {
    this.#send({ kind: 'event', event });
  }
}
