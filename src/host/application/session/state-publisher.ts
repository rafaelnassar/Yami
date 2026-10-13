/**
 * Publishes a fresh `state` event after a command changed something the
 * snapshot shows (settings, cookies, accounts, lastError). Throttling (≤ 4/s)
 * is applied by the interface layer, so publishing eagerly is fine.
 */
import type { EventSink } from '../ports/system.ts';
import type { StateProjector } from './state-projector.ts';

export interface StateChangeNotifier {
  stateChanged(): void;
}

export class StatePublisher implements StateChangeNotifier {
  readonly #projector: Pick<StateProjector, 'project'>;
  readonly #sink: EventSink;

  constructor(projector: Pick<StateProjector, 'project'>, sink: EventSink) {
    this.#projector = projector;
    this.#sink = sink;
  }

  stateChanged(): void {
    this.#sink.publish({ type: 'state', state: this.#projector.project() });
  }
}
