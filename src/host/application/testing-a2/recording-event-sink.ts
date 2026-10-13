/** Test double: records every published host event. */
import type { HostEvent, HostEventType } from '../../../shared/contracts/host-protocol.ts';
import type { EventSink } from '../ports/system.ts';

export class RecordingEventSink implements EventSink {
  readonly events: HostEvent[] = [];

  publish(event: HostEvent): void {
    this.events.push(event);
  }

  ofType<T extends HostEventType>(type: T): Extract<HostEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<HostEvent, { type: T }> => event.type === type);
  }

  types(): HostEventType[] {
    return this.events.map((event) => event.type);
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** Test double for `StateChangeNotifier`. */
export class StateNotifierSpy {
  calls = 0;

  stateChanged(): void {
    this.calls += 1;
  }
}

/** Deterministic clock. */
export class FixedClock {
  #now: number;

  constructor(now = 1_700_000_000_000) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}

/** Sequential id generator (`prefix1`, `prefix2`, …). */
export function sequentialIds(prefix = 'id'): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}${next}`;
  };
}
