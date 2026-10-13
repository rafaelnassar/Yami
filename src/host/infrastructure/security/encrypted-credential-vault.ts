/**
 * `CredentialVault` backed by `<dataDir>/vault/credentials.enc` — an encrypted
 * JSON document `{ pixiv?: PixivCredentials, <siteId>?: SiteCredentials }`, validated on every read.
 * An unreadable or undecryptable store behaves as empty (and is logged).
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isVaultSiteId } from '../../../shared/domain/oauth-sites.ts';
import { Mutex } from '../../../shared/kernel/async.ts';
import { AppError, ErrorCode } from '../../../shared/kernel/errors.ts';
import { v } from '../../../shared/validation/schema.ts';
import type { CredentialVault, PixivCredentials, SiteCredentials } from '../../application/ports/secrets.ts';
import type { Logger } from '../../application/ports/system.ts';
import { describeError, silentLogger } from '../persistence/silent-logger.ts';
import { writeFileAtomic } from './atomic-file.ts';
import type { SecretBox } from './secret-box.ts';

const ASSOCIATED_DATA = 'credentials';

export const PixivCredentialsSchema = v.object(
  {
    refreshToken: v.string({ min: 1, max: 4_096, trim: true }),
    userName: v.nullable(v.string({ max: 256 })),
    userId: v.nullable(v.string({ max: 64 })),
    savedAt: v.number({ int: true, min: 0 })
  },
  { strict: false }
);

export const SiteCredentialsSchema = v.object(
  {
    kind: v.enum(['refresh-token', 'access-token', 'oauth1', 'api-key'] as const),
    refreshToken: v.optional(v.string({ min: 1, max: 4_096, trim: true })),
    accessToken: v.optional(v.string({ min: 1, max: 4_096, trim: true })),
    accessTokenSecret: v.optional(v.string({ min: 1, max: 4_096, trim: true })),
    apiKey: v.optional(v.string({ min: 1, max: 4_096, trim: true })),
    userName: v.nullable(v.string({ max: 256 })),
    userId: v.nullable(v.string({ max: 64 })),
    savedAt: v.number({ int: true, min: 0 })
  },
  { strict: false }
);

type Store = Record<string, unknown> & { pixiv?: PixivCredentials };

export interface EncryptedCredentialVaultOptions {
  readonly dataDir: string;
  readonly box: SecretBox;
  readonly logger?: Logger;
}

function pixivToSite(credentials: PixivCredentials): SiteCredentials {
  return {
    kind: 'refresh-token',
    refreshToken: credentials.refreshToken,
    userName: credentials.userName,
    userId: credentials.userId,
    savedAt: credentials.savedAt
  };
}

function siteToPixiv(credentials: SiteCredentials): PixivCredentials | null {
  const refreshToken = credentials.refreshToken?.trim() ?? '';
  if (credentials.kind !== 'refresh-token' || refreshToken.length === 0) return null;
  return {
    refreshToken,
    userName: credentials.userName,
    userId: credentials.userId,
    savedAt: credentials.savedAt
  };
}

function storeHasCredentials(store: Store): boolean {
  for (const key of Object.keys(store)) {
    if (key === 'pixiv') {
      const parsed = PixivCredentialsSchema.parse(store.pixiv);
      if (parsed.ok) return true;
      continue;
    }
    if (!isVaultSiteId(key) || key === 'pixiv') continue;
    const parsed = SiteCredentialsSchema.parse(store[key]);
    if (parsed.ok) return true;
  }
  return false;
}

export class EncryptedCredentialVault implements CredentialVault {
  readonly #file: string;
  readonly #box: SecretBox;
  readonly #logger: Logger;
  readonly #mutex = new Mutex();

  constructor(options: EncryptedCredentialVaultOptions) {
    this.#file = path.join(options.dataDir, 'vault', 'credentials.enc');
    this.#box = options.box;
    this.#logger = (options.logger ?? silentLogger()).child({ component: 'credential-vault' });
  }

  async getPixiv(): Promise<PixivCredentials | null> {
    return (await this.#load()).pixiv ?? null;
  }

  async savePixiv(credentials: PixivCredentials): Promise<void> {
    const parsed = PixivCredentialsSchema.parse(credentials);
    if (!parsed.ok) throw new AppError(ErrorCode.VALIDATION_FAILED, { field: `pixiv.${parsed.error.path}` });
    await this.#mutex.runExclusive(async () => {
      const store = await this.#load();
      await this.#store({ ...store, pixiv: parsed.value });
    });
  }

  async clearPixiv(): Promise<void> {
    await this.clearSite('pixiv');
  }

  async getSite(siteId: string): Promise<SiteCredentials | null> {
    if (siteId === 'pixiv') {
      const pixiv = await this.getPixiv();
      return pixiv ? pixivToSite(pixiv) : null;
    }
    const raw = (await this.#load())[siteId];
    const parsed = SiteCredentialsSchema.parse(raw);
    return parsed.ok ? parsed.value : null;
  }

  async saveSite(siteId: string, credentials: SiteCredentials): Promise<void> {
    if (siteId === 'pixiv') {
      const pixiv = siteToPixiv(credentials);
      if (!pixiv) throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'pixiv.refreshToken' });
      await this.savePixiv(pixiv);
      return;
    }
    if (!isVaultSiteId(siteId)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'siteId' });
    }
    const parsed = SiteCredentialsSchema.parse(credentials);
    if (!parsed.ok) throw new AppError(ErrorCode.VALIDATION_FAILED, { field: `${siteId}.${parsed.error.path}` });
    await this.#mutex.runExclusive(async () => {
      const store = await this.#load();
      await this.#store({ ...store, [siteId]: parsed.value });
    });
  }

  async clearSite(siteId: string): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      const store = await this.#load();
      const next: Store = { ...store };
      delete next[siteId];
      await this.#store(next);
    });
  }

  async getAllSites(): Promise<ReadonlyMap<string, SiteCredentials>> {
    const store = await this.#load();
    const out = new Map<string, SiteCredentials>();
    if (store.pixiv) {
      const pixiv = PixivCredentialsSchema.parse(store.pixiv);
      if (pixiv.ok) out.set('pixiv', pixivToSite(pixiv.value));
    }
    for (const key of Object.keys(store)) {
      if (key === 'pixiv' || !isVaultSiteId(key)) continue;
      const parsed = SiteCredentialsSchema.parse(store[key]);
      if (parsed.ok) out.set(key, parsed.value);
    }
    return out;
  }

  async #load(): Promise<Store & { pixiv?: PixivCredentials }> {
    let blob: Buffer;
    try {
      blob = await readFile(this.#file);
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
      if (code !== 'ENOENT') this.#logger.warn('credentials store unreadable', { error: describeError(error) });
      return {};
    }
    const plaintext = this.#box.decrypt(blob, ASSOCIATED_DATA);
    if (!plaintext.ok) {
      this.#logger.warn('credentials store could not be decrypted');
      return {};
    }
    try {
      const data: unknown = JSON.parse(plaintext.value.toString('utf8'));
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('not object');
      const store = data as Store;
      if (store.pixiv !== undefined) {
        const pixiv = PixivCredentialsSchema.parse(store.pixiv);
        if (!pixiv.ok) delete store.pixiv;
        else store.pixiv = pixiv.value;
      }
      return store;
    } catch {
      /* fall through */
    }
    this.#logger.warn('credentials store has an invalid shape');
    return {};
  }

  async #store(store: Store): Promise<void> {
    if (!storeHasCredentials(store)) {
      await rm(this.#file, { force: true });
      return;
    }
    await writeFileAtomic(this.#file, this.#box.encrypt(JSON.stringify(store), ASSOCIATED_DATA));
  }
}
