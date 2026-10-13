/**
 * Multi-site account connect/disconnect. Single-flight globally; secrets go to the host vault only.
 */
import { parseApiKeyUserIdPaste } from '../../../shared/domain/api-key-credentials.ts';
import { uiSiteById, vaultIdForUiSite, type OAuthUiSiteId } from '../../../shared/domain/oauth-sites.ts';
import type { AccountsDto } from '../../../shared/contracts/dto.ts';
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { describeError, type Logger } from '../../infrastructure/logger.ts';
import type { PixivTokenResult } from './pixiv-protocol.ts';
import type { SiteOAuthResult } from './site-oauth-result.ts';

export interface OAuthAccountsDeps {
  readonly loginPixiv: () => Promise<Result<PixivTokenResult, AppErrorData>>;
  readonly loginSite: (vaultId: string) => Promise<Result<SiteOAuthResult, AppErrorData>>;
  readonly savePixiv: (
    payload: CommandPayload<'accounts.pixiv.save'>
  ) => Promise<Result<CommandResult<'accounts.pixiv.save'>, AppErrorData>>;
  readonly clearPixiv: () => Promise<Result<CommandResult<'accounts.pixiv.clear'>, AppErrorData>>;
  readonly saveSite: (
    payload: CommandPayload<'accounts.site.save'>
  ) => Promise<Result<CommandResult<'accounts.site.save'>, AppErrorData>>;
  readonly clearSite: (
    payload: CommandPayload<'accounts.site.clear'>
  ) => Promise<Result<CommandResult<'accounts.site.clear'>, AppErrorData>>;
  readonly clearPixivWebSession: () => Promise<void>;
  readonly clearSiteWebSession: (vaultId: string) => Promise<void>;
  readonly hostReady: () => boolean;
  readonly vaultReady: () => boolean;
  readonly logger: Logger;
}

function oauthInProgressError(): AppErrorData {
  return appError(ErrorCode.OAUTH_LOGIN_IN_PROGRESS);
}

export class OAuthAccounts {
  readonly #deps: OAuthAccountsDeps;
  #loginInFlight = false;

  constructor(deps: OAuthAccountsDeps) {
    this.#deps = deps;
  }

  connect(uiSiteId: OAuthUiSiteId): Promise<Result<AccountsDto, AppErrorData>> {
    const site = uiSiteById(uiSiteId);
    if (site.auth !== 'oauth') {
      return Promise.resolve(
        err(
          appError(ErrorCode.NOT_SUPPORTED, {
            feature: uiSiteId === 'flickr' ? 'flickr-oauth' : `${uiSiteId}-oauth`
          })
        )
      );
    }
    const vaultId = vaultIdForUiSite(uiSiteId);
    if (vaultId === 'pixiv') return this.#connectPixiv();
    return this.#connectGeneric(vaultId);
  }

  disconnect(uiSiteId: OAuthUiSiteId): Promise<Result<AccountsDto, AppErrorData>> {
    const vaultId = vaultIdForUiSite(uiSiteId);
    if (vaultId === 'pixiv') return this.#disconnectPixiv();
    return this.#disconnectGeneric(vaultId);
  }

  /** Save pasted API Access Credentials (Gelbooru-style `api_key` + `user_id`). */
  async saveApiKey(uiSiteId: OAuthUiSiteId, credentials: string): Promise<Result<AccountsDto, AppErrorData>> {
    const site = uiSiteById(uiSiteId);
    if (site.auth !== 'api-key') {
      return err(appError(ErrorCode.NOT_SUPPORTED, { feature: `${uiSiteId}-api-key` }));
    }
    if (!this.#deps.hostReady()) return err(appError(ErrorCode.HOST_UNAVAILABLE));
    if (!this.#deps.vaultReady()) return err(appError(ErrorCode.VAULT_UNAVAILABLE));
    const parsed = parseApiKeyUserIdPaste(credentials);
    if (!parsed) return err(appError(ErrorCode.VALIDATION_FAILED, { path: 'credentials' }));
    const saved = await this.#deps.saveSite({
      siteId: site.vaultId,
      kind: 'api-key',
      apiKey: parsed.apiKey,
      userName: null,
      userId: parsed.userId
    });
    return saved.ok ? ok(saved.value.accounts) : saved;
  }

  connectPixiv(): Promise<Result<AccountsDto, AppErrorData>> {
    return this.#connectPixiv();
  }

  disconnectPixiv(): Promise<Result<AccountsDto, AppErrorData>> {
    return this.#disconnectPixiv();
  }

  async #connectPixiv(): Promise<Result<AccountsDto, AppErrorData>> {
    if (this.#loginInFlight) return err(oauthInProgressError());
    if (!this.#deps.hostReady()) return err(appError(ErrorCode.HOST_UNAVAILABLE));
    if (!this.#deps.vaultReady()) return err(appError(ErrorCode.VAULT_UNAVAILABLE));
    this.#loginInFlight = true;
    try {
      const token = await this.#deps.loginPixiv();
      if (!token.ok) return token;
      const saved = await this.#deps.savePixiv({
        refreshToken: token.value.refreshToken,
        userName: token.value.userName,
        userId: token.value.userId
      });
      return saved.ok ? ok(saved.value.accounts) : saved;
    } finally {
      this.#loginInFlight = false;
    }
  }

  async #connectGeneric(vaultId: string): Promise<Result<AccountsDto, AppErrorData>> {
    if (this.#loginInFlight) return err(oauthInProgressError());
    if (!this.#deps.hostReady()) return err(appError(ErrorCode.HOST_UNAVAILABLE));
    if (!this.#deps.vaultReady()) return err(appError(ErrorCode.VAULT_UNAVAILABLE));
    this.#loginInFlight = true;
    try {
      const token = await this.#deps.loginSite(vaultId);
      if (!token.ok) return token;
      const saved = await this.#deps.saveSite({
        siteId: vaultId,
        kind: token.value.kind,
        refreshToken: token.value.refreshToken,
        accessToken: token.value.accessToken,
        accessTokenSecret: token.value.accessTokenSecret,
        userName: token.value.userName,
        userId: token.value.userId
      });
      return saved.ok ? ok(saved.value.accounts) : saved;
    } finally {
      this.#loginInFlight = false;
    }
  }

  async #disconnectPixiv(): Promise<Result<AccountsDto, AppErrorData>> {
    const cleared = await this.#deps.clearPixiv();
    try {
      await this.#deps.clearPixivWebSession();
    } catch (error) {
      this.#deps.logger.warn('pixiv web session cleanup failed', describeError(error));
    }
    return cleared.ok ? ok(cleared.value.accounts) : cleared;
  }

  async #disconnectGeneric(vaultId: string): Promise<Result<AccountsDto, AppErrorData>> {
    const cleared = await this.#deps.clearSite({ siteId: vaultId });
    try {
      await this.#deps.clearSiteWebSession(vaultId);
    } catch (error) {
      this.#deps.logger.warn('oauth web session cleanup failed', { siteId: vaultId, ...describeError(error) });
    }
    return cleared.ok ? ok(cleared.value.accounts) : cleared;
  }
}
