/** `notices.clearError` — forgets `lastError` and republishes the state. */
import type { CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { NoticeCenter } from './notice-center.ts';
import type { StateChangeNotifier } from './state-publisher.ts';

export class NoticesService {
  readonly #center: Pick<NoticeCenter, 'clearError' | 'lastError'>;
  readonly #state: StateChangeNotifier;

  constructor(center: Pick<NoticeCenter, 'clearError' | 'lastError'>, state: StateChangeNotifier) {
    this.#center = center;
    this.#state = state;
  }

  clearError(): Result<CommandResult<'notices.clearError'>, AppErrorData> {
    if (this.#center.lastError() !== null) {
      this.#center.clearError();
      this.#state.stateChanged();
    }
    return ok({});
  }
}
