/**
 * Public account status (never the token), cached in memory so the state
 * snapshot can be built synchronously on every progress tick.
 */
import { VAULT_SITE_IDS } from '../../../shared/domain/oauth-sites.ts';
import type { AccountStatusDto, AccountsDto } from '../../../shared/contracts/dto.ts';
import type { CredentialVault, PixivCredentials, SiteCredentials } from '../ports/secrets.ts';

export interface AccountsSource {
  current(): AccountsDto;
}

function disconnectedSite(): AccountStatusDto {
  return { connected: false, userName: null };
}

function statusFromCredentials(credentials: SiteCredentials | null): AccountStatusDto {
  if (!credentials) return disconnectedSite();
  const hasSecret =
    (credentials.kind === 'refresh-token' && (credentials.refreshToken?.trim().length ?? 0) > 0) ||
    (credentials.kind === 'access-token' && (credentials.accessToken?.trim().length ?? 0) > 0) ||
    (credentials.kind === 'oauth1' &&
      (credentials.accessToken?.trim().length ?? 0) > 0 &&
      (credentials.accessTokenSecret?.trim().length ?? 0) > 0) ||
    (credentials.kind === 'api-key' &&
      (credentials.apiKey?.trim().length ?? 0) > 0 &&
      (credentials.userId?.trim().length ?? 0) > 0);
  if (!hasSecret) return disconnectedSite();
  return { connected: true, userName: credentials.userName };
}

export function emptySitesRecord(): Readonly<Record<string, AccountStatusDto>> {
  return Object.fromEntries(VAULT_SITE_IDS.map((id) => [id, disconnectedSite()]));
}

export const DISCONNECTED_ACCOUNTS: AccountsDto = {
  sites: emptySitesRecord(),
  pixiv: disconnectedSite()
};

export function toAccountsDtoFromMap(sites: ReadonlyMap<string, SiteCredentials>): AccountsDto {
  const record = { ...emptySitesRecord() } as Record<string, AccountStatusDto>;
  for (const id of VAULT_SITE_IDS) {
    record[id] = statusFromCredentials(sites.get(id) ?? null);
  }
  return { sites: record, pixiv: record.pixiv ?? disconnectedSite() };
}

/** Builds public status from a lone Pixiv credential (tests and legacy importers). */
export function toAccountsDto(pixiv: PixivCredentials | null): AccountsDto {
  const sites = new Map<string, SiteCredentials>();
  if (pixiv && pixiv.refreshToken.trim().length > 0) {
    sites.set('pixiv', {
      kind: 'refresh-token',
      refreshToken: pixiv.refreshToken,
      userName: pixiv.userName,
      userId: pixiv.userId,
      savedAt: pixiv.savedAt
    });
  }
  return toAccountsDtoFromMap(sites);
}

export class AccountsStatus implements AccountsSource {
  readonly #vault: Pick<CredentialVault, 'getAllSites'>;
  #current: AccountsDto = DISCONNECTED_ACCOUNTS;
  #loaded = false;

  constructor(vault: Pick<CredentialVault, 'getAllSites'>) {
    this.#vault = vault;
  }

  current(): AccountsDto {
    return this.#current;
  }

  /** Re-reads the vault (call after configure and whenever credentials change elsewhere). */
  async refresh(): Promise<AccountsDto> {
    this.set(await this.#vault.getAllSites());
    return this.#current;
  }

  async ensureLoaded(): Promise<AccountsDto> {
    return this.#loaded ? this.#current : this.refresh();
  }

  set(sites: ReadonlyMap<string, SiteCredentials>): void {
    this.#current = toAccountsDtoFromMap(sites);
    this.#loaded = true;
  }
}
