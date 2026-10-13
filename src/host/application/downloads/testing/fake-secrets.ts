/**
 * Fake secret vaults (plaintext, in memory).
 */
import { appError, ErrorCode, type AppErrorData } from '../../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../../shared/kernel/result.ts';
import type { CookieFileDto } from '../../../../shared/contracts/dto.ts';
import type { CookieVault, CredentialVault, PixivCredentials, SiteCredentials } from '../../ports/secrets.ts';

export class FakeCookieVault implements CookieVault {
  readonly files = new Map<string, string>();
  readonly materialized: { readonly name: string; readonly dir: string }[] = [];
  readonly absorbed: { readonly name: string; readonly file: string }[] = [];
  /** Behaves like the disabled vault (key unavailable): nothing listed, nothing readable. */
  unavailable = false;

  async list(): Promise<CookieFileDto[]> {
    if (this.unavailable) return [];
    return [...this.files.entries()].map(([name, content]) => ({
      name,
      sizeBytes: content.length,
      updatedAt: 0,
      domains: []
    }));
  }

  async exists(name: string): Promise<boolean> {
    return !this.unavailable && this.files.has(name);
  }

  async save(name: string, content: string): Promise<Result<CookieFileDto, AppErrorData>> {
    this.files.set(name, content);
    return ok({ name, sizeBytes: content.length, updatedAt: 0, domains: [] });
  }

  async remove(name: string): Promise<Result<void, AppErrorData>> {
    this.files.delete(name);
    return ok();
  }

  async materialize(name: string, targetDir: string): Promise<Result<string, AppErrorData>> {
    if (this.unavailable) return err(appError(ErrorCode.VAULT_UNAVAILABLE));
    if (!this.files.has(name)) return err(appError(ErrorCode.COOKIES_NOT_FOUND));
    this.materialized.push({ name, dir: targetDir });
    return ok(`${targetDir}/${name}`);
  }

  async absorb(name: string, updatedFile: string): Promise<void> {
    this.absorbed.push({ name, file: updatedFile });
  }

  async domainsOf(): Promise<readonly string[]> {
    return [];
  }
}

export class FakeCredentialVault implements CredentialVault {
  pixiv: PixivCredentials | null = null;
  readonly sites = new Map<string, SiteCredentials>();

  async getPixiv(): Promise<PixivCredentials | null> {
    return this.pixiv;
  }

  async savePixiv(credentials: PixivCredentials): Promise<void> {
    this.pixiv = credentials;
    this.sites.set('pixiv', {
      kind: 'refresh-token',
      refreshToken: credentials.refreshToken,
      userName: credentials.userName,
      userId: credentials.userId,
      savedAt: credentials.savedAt
    });
  }

  async clearPixiv(): Promise<void> {
    this.pixiv = null;
    this.sites.delete('pixiv');
  }

  async getSite(siteId: string): Promise<SiteCredentials | null> {
    if (siteId === 'pixiv') {
      return this.pixiv
        ? {
            kind: 'refresh-token',
            refreshToken: this.pixiv.refreshToken,
            userName: this.pixiv.userName,
            userId: this.pixiv.userId,
            savedAt: this.pixiv.savedAt
          }
        : null;
    }
    return this.sites.get(siteId) ?? null;
  }

  async saveSite(siteId: string, credentials: SiteCredentials): Promise<void> {
    if (siteId === 'pixiv' && credentials.kind === 'refresh-token' && credentials.refreshToken) {
      await this.savePixiv({
        refreshToken: credentials.refreshToken,
        userName: credentials.userName,
        userId: credentials.userId,
        savedAt: credentials.savedAt
      });
      return;
    }
    this.sites.set(siteId, credentials);
  }

  async clearSite(siteId: string): Promise<void> {
    if (siteId === 'pixiv') {
      await this.clearPixiv();
      return;
    }
    this.sites.delete(siteId);
  }

  async getAllSites(): Promise<ReadonlyMap<string, SiteCredentials>> {
    const out = new Map(this.sites);
    if (this.pixiv && !out.has('pixiv')) {
      out.set('pixiv', {
        kind: 'refresh-token',
        refreshToken: this.pixiv.refreshToken,
        userName: this.pixiv.userName,
        userId: this.pixiv.userId,
        savedAt: this.pixiv.savedAt
      });
    }
    return out;
  }
}
