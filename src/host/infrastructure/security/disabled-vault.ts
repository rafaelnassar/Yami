/**
 * Secret stores used while the vault is disabled: main could not load the data key
 * (`system.configure` without `vaultKey`), so the encrypted files cannot be read. The host
 * still runs normally (downloads, history, library); nothing under `vault/` is read,
 * written or deleted, so a later reset or recovered key finds it untouched.
 *
 * - Listings are empty and lookups miss: automatic cookie selection (site rules, default
 *   file) finds nothing and downloads run without cookies; the Pixiv token is absent.
 * - Storing, removing or decrypting a secret fails with `VAULT_UNAVAILABLE`, so a cookie
 *   file chosen explicitly for a download makes it fail with the `vault-unavailable` reason.
 */
import { AppError, ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, type Result } from '../../../shared/kernel/result.ts';
import type { CookieFileDto } from '../../../shared/contracts/dto.ts';
import type {
  CookieVault,
  CredentialVault,
  PixivCredentials,
  SiteCredentials
} from '../../application/ports/secrets.ts';

const unavailable = (): Result<never, AppErrorData> => err(appError(ErrorCode.VAULT_UNAVAILABLE));

export class DisabledCookieVault implements CookieVault {
  async list(): Promise<CookieFileDto[]> {
    return [];
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async save(): Promise<Result<CookieFileDto, AppErrorData>> {
    return unavailable();
  }

  async remove(): Promise<Result<void, AppErrorData>> {
    return unavailable();
  }

  async materialize(): Promise<Result<string, AppErrorData>> {
    return unavailable();
  }

  /** Nothing was ever materialized from this vault. */
  async absorb(): Promise<void> {
    return undefined;
  }

  async domainsOf(): Promise<readonly string[]> {
    return [];
  }
}

export class DisabledCredentialVault implements CredentialVault {
  async getPixiv(): Promise<PixivCredentials | null> {
    return null;
  }

  async savePixiv(): Promise<void> {
    throw new AppError(ErrorCode.VAULT_UNAVAILABLE);
  }

  /** Refused as well: clearing would have to rewrite (or delete) the unreadable store. */
  async clearPixiv(): Promise<void> {
    throw new AppError(ErrorCode.VAULT_UNAVAILABLE);
  }

  async getSite(): Promise<SiteCredentials | null> {
    return null;
  }

  async saveSite(): Promise<void> {
    throw new AppError(ErrorCode.VAULT_UNAVAILABLE);
  }

  async clearSite(): Promise<void> {
    throw new AppError(ErrorCode.VAULT_UNAVAILABLE);
  }

  async getAllSites(): Promise<ReadonlyMap<string, SiteCredentials>> {
    return new Map();
  }
}
