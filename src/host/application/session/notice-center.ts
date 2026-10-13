/**
 * `EventSink` decorator that remembers the most recent error notice so the
 * state snapshot can expose it as `lastError`. Every event is forwarded
 * unchanged; the application only needs to publish through this sink.
 */
import type { NoticeDto } from '../../../shared/contracts/dto.ts';
import type { HostEvent } from '../../../shared/contracts/host-protocol.ts';
import type { EventSink } from '../ports/system.ts';

/** Read side used by the state projector. */
export interface LastErrorSource {
  lastError(): NoticeDto | null;
}

export class NoticeCenter implements EventSink, LastErrorSource {
  readonly #inner: EventSink;
  #lastError: NoticeDto | null = null;

  constructor(inner: EventSink) {
    this.#inner = inner;
  }

  publish(event: HostEvent): void {
    if (event.type === 'notice' && event.notice.kind === 'error') this.#lastError = event.notice;
    // A dismissed error notice must not linger in the snapshot either.
    if (event.type === 'notice.dismissed' && this.#lastError?.id === event.id) this.#lastError = null;
    this.#inner.publish(event);
  }

  lastError(): NoticeDto | null {
    return this.#lastError;
  }

  clearError(): void {
    this.#lastError = null;
  }
}
