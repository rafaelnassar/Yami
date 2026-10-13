/** `settings.setDefaultEngine` — engine preselected for new downloads (tray, composer fallback). */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { StateChangeNotifier } from '../session/state-publisher.ts';
import type { SettingsStore } from './settings-store.ts';

export class SetDefaultEngineService {
  readonly #settings: Pick<SettingsStore, 'read' | 'update'>;
  readonly #state: StateChangeNotifier;

  constructor(settings: Pick<SettingsStore, 'read' | 'update'>, state: StateChangeNotifier) {
    this.#settings = settings;
    this.#state = state;
  }

  setDefaultEngine(
    payload: CommandPayload<'settings.setDefaultEngine'>
  ): Result<CommandResult<'settings.setDefaultEngine'>, AppErrorData> {
    // The tray sends this before every start; skip the write when nothing changes.
    if (this.#settings.read().defaultEngine !== payload.engine) {
      this.#settings.update((current) => ({ ...current, defaultEngine: payload.engine }));
      this.#state.stateChanged();
    }
    return ok({ engine: payload.engine });
  }
}
