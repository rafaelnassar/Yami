/**
 * Pixiv connect/disconnect. Single-flight login; the refresh token goes straight from
 * the OAuth flow to the host vault (`accounts.pixiv.save`) — it never reaches the
 * renderer nor main's disk. Disconnect also wipes the login partition (legacy kept it).
 */
import type { AccountsDto } from '../../../shared/contracts/dto.ts';
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { describeError, type Logger } from '../../infrastructure/logger.ts';
import type { PixivTokenResult } from './pixiv-protocol.ts';

export interface PixivAccountDeps {
  readonly login: () => Promise<Result<PixivTokenResult, AppErrorData>>;
  readonly save: (
    payload: CommandPayload<'accounts.pixiv.save'>
  ) => Promise<Result<CommandResult<'accounts.pixiv.save'>, AppErrorData>>;
  readonly clear: () => Promise<Result<CommandResult<'accounts.pixiv.clear'>, AppErrorData>>;
  readonly clearWebSession: () => Promise<void>;
  readonly hostReady: () => boolean;
  /** False while the host runs with a disabled vault (the key could not be loaded). */
  readonly vaultReady: () => boolean;
  readonly logger: Logger;
}

export class PixivAccount {
  readonly #deps: PixivAccountDeps;
  #loginInFlight = false;

  constructor(deps: PixivAccountDeps) {
    this.#deps = deps;
  }

  async connect(): Promise<Result<AccountsDto, AppErrorData>> {
    if (this.#loginInFlight) return err(appError(ErrorCode.PIXIV_LOGIN_IN_PROGRESS));
    // Fail fast: a token obtained while the vault is unreachable would be lost.
    if (!this.#deps.hostReady()) return err(appError(ErrorCode.HOST_UNAVAILABLE));
    if (!this.#deps.vaultReady()) return err(appError(ErrorCode.VAULT_UNAVAILABLE));
    this.#loginInFlight = true;
    try {
      const token = await this.#deps.login();
      if (!token.ok) return token;
      const saved = await this.#deps.save({
        refreshToken: token.value.refreshToken,
        userName: token.value.userName,
        userId: token.value.userId
      });
      return saved.ok ? ok(saved.value.accounts) : saved;
    } finally {
      this.#loginInFlight = false;
    }
  }

  async disconnect(): Promise<Result<AccountsDto, AppErrorData>> {
    const cleared = await this.#deps.clear();
    try {
      await this.#deps.clearWebSession();
    } catch (error) {
      this.#deps.logger.warn('pixiv web session cleanup failed', describeError(error));
    }
    return cleared.ok ? ok(cleared.value.accounts) : cleared;
  }
}
