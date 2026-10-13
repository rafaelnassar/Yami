/**
 * Secret storage ports (implemented by `host/infrastructure/security`).
 * Secrets are encrypted at rest (AES-256-GCM) with a data key provided by the
 * main process (itself protected by the OS keychain / DPAPI via `safeStorage`).
 * Plaintext only ever exists in memory or in per-download private files that are
 * deleted when the download ends.
 */
import type { SiteCredentialKind } from '../../../shared/domain/oauth-sites.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import type { CookieFileDto } from '../../../shared/contracts/dto.ts';

export interface CookieVault {
  list(): Promise<CookieFileDto[]>;
  exists(name: string): Promise<boolean>;
  /** Validates Netscape cookie format, encrypts and stores (overwrites same name). */
  save(name: string, content: string): Promise<Result<CookieFileDto, AppErrorData>>;
  remove(name: string): Promise<Result<void, AppErrorData>>;
  /**
   * Decrypts into `targetDir/<name>` with 0600 permissions; returns the file path.
   * The vault remembers what it handed to that copy (see `absorb`).
   */
  materialize(name: string, targetDir: string): Promise<Result<string, AppErrorData>>;
  /**
   * Re-encrypts a materialized copy the engine may have updated (e.g. refreshed
   * sessions) — compare-and-swap: only if the user did not save or remove that
   * cookie since `materialize`, so a re-import made while the download ran is never
   * overwritten; between jobs sharing a cookie the last one to finish wins.
   * Unchanged or untracked copies are ignored.
   */
  absorb(name: string, updatedFile: string): Promise<void>;
  /** Hosts found in each stored file, used for automatic cookie selection by site. */
  domainsOf(name: string): Promise<readonly string[]>;
}

export interface PixivCredentials {
  readonly refreshToken: string;
  readonly userName: string | null;
  readonly userId: string | null;
  readonly savedAt: number;
}

export type { SiteCredentialKind };

export interface SiteCredentials {
  readonly kind: SiteCredentialKind;
  readonly refreshToken?: string;
  readonly accessToken?: string;
  readonly accessTokenSecret?: string;
  readonly apiKey?: string;
  readonly userName: string | null;
  readonly userId: string | null;
  readonly savedAt: number;
}

export interface CredentialVault {
  getPixiv(): Promise<PixivCredentials | null>;
  savePixiv(credentials: PixivCredentials): Promise<void>;
  clearPixiv(): Promise<void>;
  getSite(siteId: string): Promise<SiteCredentials | null>;
  saveSite(siteId: string, credentials: SiteCredentials): Promise<void>;
  clearSite(siteId: string): Promise<void>;
  getAllSites(): Promise<ReadonlyMap<string, SiteCredentials>>;
}
