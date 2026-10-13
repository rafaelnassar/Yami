/**
 * `session.init` — returns the current snapshot. Unlike the legacy `init` it has
 * no side effects (no probes, installs or network checks): the tray may call it
 * every time it opens.
 */
import type { CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { AccountsStatus } from '../accounts/accounts-status.ts';
import type { StateProjector } from './state-projector.ts';

export class SessionService {
  readonly #projector: Pick<StateProjector, 'project'>;
  readonly #accounts: Pick<AccountsStatus, 'ensureLoaded'>;

  constructor(projector: Pick<StateProjector, 'project'>, accounts: Pick<AccountsStatus, 'ensureLoaded'>) {
    this.#projector = projector;
    this.#accounts = accounts;
  }

  async init(): Promise<Result<CommandResult<'session.init'>, AppErrorData>> {
    // Only the first call reads the vault; later calls use the cached status.
    await this.#accounts.ensureLoaded();
    return ok({ state: this.#projector.project() });
  }
}
