/**
 * `accounts.pixiv.save` / `accounts.pixiv.clear` (main-only). The refresh token
 * comes from main's OAuth flow, is stored encrypted by the vault and is never
 * returned: responses carry only `{ connected, userName }`.
 */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { CredentialVault, PixivCredentials } from '../ports/secrets.ts';
import type { StateChangeNotifier } from '../session/state-publisher.ts';
import type { AccountsStatus } from './accounts-status.ts';

function trimmedOrNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export class PixivAccountService {
  readonly #vault: Pick<CredentialVault, 'savePixiv' | 'clearPixiv' | 'getAllSites'>;
  readonly #status: Pick<AccountsStatus, 'set' | 'current'>;
  readonly #state: StateChangeNotifier;
  readonly #clock: Clock;

  constructor(
    vault: Pick<CredentialVault, 'savePixiv' | 'clearPixiv' | 'getAllSites'>,
    status: Pick<AccountsStatus, 'set' | 'current'>,
    state: StateChangeNotifier,
    clock: Clock
  ) {
    this.#vault = vault;
    this.#status = status;
    this.#state = state;
    this.#clock = clock;
  }

  async save(
    payload: CommandPayload<'accounts.pixiv.save'>
  ): Promise<Result<CommandResult<'accounts.pixiv.save'>, AppErrorData>> {
    const refreshToken = payload.refreshToken.trim();
    // Tokens never contain whitespace; one that does is corrupted input.
    if (refreshToken.length < 10 || /\s/.test(refreshToken)) {
      return err(appError(ErrorCode.VALIDATION_FAILED, { path: 'refreshToken' }));
    }
    const credentials: PixivCredentials = {
      refreshToken,
      userName: trimmedOrNull(payload.userName),
      userId: trimmedOrNull(payload.userId),
      savedAt: this.#clock.now()
    };
    await this.#vault.savePixiv(credentials);
    this.#status.set(await this.#vault.getAllSites());
    this.#state.stateChanged();
    return ok({ accounts: this.#status.current() });
  }

  async clear(): Promise<Result<CommandResult<'accounts.pixiv.clear'>, AppErrorData>> {
    await this.#vault.clearPixiv();
    this.#status.set(await this.#vault.getAllSites());
    this.#state.stateChanged();
    return ok({ accounts: this.#status.current() });
  }
}
