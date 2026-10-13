/**
 * `accounts.site.save` / `accounts.site.clear` (main-only). Tokens from OAuth never
 * reach the renderer; responses carry only `{ connected, userName }` per site.
 */
import { isVaultSiteId } from '../../../shared/domain/oauth-sites.ts';
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { CredentialVault, SiteCredentials } from '../ports/secrets.ts';
import type { StateChangeNotifier } from '../session/state-publisher.ts';
import type { AccountsStatus } from './accounts-status.ts';

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function validateTokenField(token: string, path: string): Result<string, AppErrorData> {
  const trimmed = token.trim();
  if (trimmed.length < 10 || /\s/.test(trimmed)) {
    return err(appError(ErrorCode.VALIDATION_FAILED, { path }));
  }
  return ok(trimmed);
}

export class SiteAccountService {
  readonly #vault: Pick<CredentialVault, 'saveSite' | 'clearSite' | 'getAllSites'>;
  readonly #status: Pick<AccountsStatus, 'set' | 'current'>;
  readonly #state: StateChangeNotifier;
  readonly #clock: Clock;

  constructor(
    vault: Pick<CredentialVault, 'saveSite' | 'clearSite' | 'getAllSites'>,
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
    payload: CommandPayload<'accounts.site.save'>
  ): Promise<Result<CommandResult<'accounts.site.save'>, AppErrorData>> {
    if (!isVaultSiteId(payload.siteId)) {
      return err(appError(ErrorCode.VALIDATION_FAILED, { path: 'siteId' }));
    }
    const built = this.#buildCredentials(payload);
    if (!built.ok) return built;
    await this.#vault.saveSite(payload.siteId, built.value);
    this.#status.set(await this.#vault.getAllSites());
    this.#state.stateChanged();
    return ok({ accounts: this.#status.current() });
  }

  async clear(
    payload: CommandPayload<'accounts.site.clear'>
  ): Promise<Result<CommandResult<'accounts.site.clear'>, AppErrorData>> {
    if (!isVaultSiteId(payload.siteId)) {
      return err(appError(ErrorCode.VALIDATION_FAILED, { path: 'siteId' }));
    }
    await this.#vault.clearSite(payload.siteId);
    this.#status.set(await this.#vault.getAllSites());
    this.#state.stateChanged();
    return ok({ accounts: this.#status.current() });
  }

  #buildCredentials(payload: CommandPayload<'accounts.site.save'>): Result<SiteCredentials, AppErrorData> {
    const kind = payload.kind;
    const savedAt = this.#clock.now();
    const userName = trimmedOrNull(payload.userName);
    const userId = trimmedOrNull(payload.userId);

    if (kind === 'refresh-token') {
      const token = validateTokenField(payload.refreshToken ?? '', 'refreshToken');
      if (!token.ok) return token;
      return ok({
        kind,
        refreshToken: token.value,
        userName,
        userId,
        savedAt
      });
    }
    if (kind === 'access-token') {
      const token = validateTokenField(payload.accessToken ?? '', 'accessToken');
      if (!token.ok) return token;
      return ok({
        kind,
        accessToken: token.value,
        userName,
        userId,
        savedAt
      });
    }
    if (kind === 'oauth1') {
      const access = validateTokenField(payload.accessToken ?? '', 'accessToken');
      if (!access.ok) return access;
      const secret = validateTokenField(payload.accessTokenSecret ?? '', 'accessTokenSecret');
      if (!secret.ok) return secret;
      return ok({
        kind,
        accessToken: access.value,
        accessTokenSecret: secret.value,
        userName,
        userId,
        savedAt
      });
    }
    if (kind === 'api-key') {
      const apiKey = validateTokenField(payload.apiKey ?? '', 'apiKey');
      if (!apiKey.ok) return apiKey;
      if (!userId) return err(appError(ErrorCode.VALIDATION_FAILED, { path: 'userId' }));
      return ok({
        kind,
        apiKey: apiKey.value,
        userName,
        userId,
        savedAt
      });
    }
    return err(appError(ErrorCode.VALIDATION_FAILED, { path: 'kind' }));
  }
}
