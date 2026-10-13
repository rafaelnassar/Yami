/** Fakes for the secret vault ports (plaintext in memory). */
import type { CookieFileDto } from '../../../shared/contracts/dto.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { CookieVault, CredentialVault, PixivCredentials, SiteCredentials } from '../ports/secrets.ts';

export class FakeCookieVault implements CookieVault {
  readonly files = new Map<string, string>();
  saveError: AppErrorData | null = null;
  removeError: AppErrorData | null = null;
  listCalls = 0;

  constructor(names: readonly string[] = []) {
    for (const name of names) this.files.set(name, '# Netscape HTTP Cookie File\n');
  }

  async list(): Promise<CookieFileDto[]> {
    this.listCalls += 1;
    return [...this.files.entries()].map(([name, content]) => ({
      name,
      sizeBytes: content.length,
      updatedAt: 1,
      domains: []
    }));
  }
  async exists(name: string): Promise<boolean> {
    return this.files.has(name);
  }
  async save(name: string, content: string): Promise<Result<CookieFileDto, AppErrorData>> {
    if (this.saveError) return err(this.saveError);
    this.files.set(name, content);
    return ok({ name, sizeBytes: content.length, updatedAt: 1, domains: [] });
  }
  async remove(name: string): Promise<Result<void, AppErrorData>> {
    if (this.removeError) return err(this.removeError);
    if (!this.files.delete(name)) return err(appError(ErrorCode.COOKIES_NOT_FOUND, { name }));
    return ok();
  }
  async materialize(name: string, targetDir: string): Promise<Result<string, AppErrorData>> {
    return this.files.has(name) ? ok(`${targetDir}/${name}`) : err(appError(ErrorCode.COOKIES_NOT_FOUND));
  }
  async absorb(): Promise<void> {}
  async domainsOf(): Promise<readonly string[]> {
    return [];
  }
}

export class FakeCredentialVault implements CredentialVault {
  pixiv: PixivCredentials | null = null;
  readonly sites = new Map<string, SiteCredentials>();
  reads = 0;

  async getPixiv(): Promise<PixivCredentials | null> {
    this.reads += 1;
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
    if (siteId === 'pixiv') return this.getSiteCredentialsPixiv();
    return this.sites.get(siteId) ?? null;
  }

  async saveSite(siteId: string, credentials: SiteCredentials): Promise<void> {
    if (siteId === 'pixiv' && credentials.refreshToken) {
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
    this.reads += 1;
    const out = new Map(this.sites);
    const pixiv = await this.getSiteCredentialsPixiv();
    if (pixiv) out.set('pixiv', pixiv);
    return out;
  }

  async getSiteCredentialsPixiv(): Promise<SiteCredentials | null> {
    if (!this.pixiv) return null;
    return {
      kind: 'refresh-token',
      refreshToken: this.pixiv.refreshToken,
      userName: this.pixiv.userName,
      userId: this.pixiv.userId,
      savedAt: this.pixiv.savedAt
    };
  }
}
