/**
 * On-disk PNG thumbnail cache (`userData/cache/thumbnails/<sha1>.png`) with an LRU size
 * cap (~200 MB). The key covers path + mtime + size + variant, so edited files get fresh
 * thumbnails and stale ones age out.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomicSync } from '../../infrastructure/atomic-file.ts';
import type { Logger } from '../../infrastructure/logger.ts';

export interface CachedThumbnail {
  readonly path: string;
  readonly size: number;
}

export interface ThumbnailCacheOptions {
  readonly dir: string;
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly logger: Logger;
}

export function thumbnailKey(filePath: string, mtimeMs: number, size: number, variant: string): string {
  return createHash('sha1')
    .update(`${filePath}\u0000${Math.floor(mtimeMs)}\u0000${size}\u0000${variant}`)
    .digest('hex');
}

export class ThumbnailCache {
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #logger: Logger;
  #index: Map<string, { size: number; usedAt: number }> | null = null;

  constructor(options: ThumbnailCacheOptions) {
    this.#dir = options.dir;
    this.#maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  fileFor(key: string): string {
    return path.join(this.#dir, `${key}.png`);
  }

  async get(key: string): Promise<CachedThumbnail | null> {
    const file = this.fileFor(key);
    try {
      const info = await stat(file);
      const now = this.#now();
      (await this.#loadIndex()).set(key, { size: info.size, usedAt: now });
      // mtime doubles as "last used" so the LRU order survives restarts.
      await utimes(file, now / 1000, now / 1000).catch(() => undefined);
      return { path: file, size: info.size };
    } catch {
      return null;
    }
  }

  async put(key: string, png: Uint8Array): Promise<CachedThumbnail> {
    await mkdir(this.#dir, { recursive: true });
    const file = this.fileFor(key);
    // A cache: a thumbnail lost to a power cut is simply rendered again (no fsync cost).
    writeFileAtomicSync(file, png, { durable: false });
    const index = await this.#loadIndex();
    index.set(key, { size: png.byteLength, usedAt: this.#now() });
    await this.#evict(key);
    return { path: file, size: png.byteLength };
  }

  async #loadIndex(): Promise<Map<string, { size: number; usedAt: number }>> {
    if (this.#index) return this.#index;
    const index = new Map<string, { size: number; usedAt: number }>();
    try {
      for (const name of await readdir(this.#dir)) {
        if (!/^[a-f0-9]{40}\.png$/.test(name)) continue;
        const info = await stat(path.join(this.#dir, name)).catch(() => null);
        if (info?.isFile()) index.set(name.slice(0, 40), { size: info.size, usedAt: info.mtimeMs });
      }
    } catch {
      // Missing directory: empty cache.
    }
    this.#index ??= index;
    return this.#index;
  }

  async #evict(keep: string): Promise<void> {
    const index = await this.#loadIndex();
    let total = 0;
    for (const entry of index.values()) total += entry.size;
    if (total <= this.#maxBytes) return;
    const oldestFirst = [...index.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, entry] of oldestFirst) {
      if (total <= this.#maxBytes * 0.9) break;
      if (key === keep) continue;
      index.delete(key);
      total -= entry.size;
      await rm(this.fileFor(key), { force: true }).catch((error: unknown) =>
        this.#logger.debug('thumbnail evict failed', { error: String(error) })
      );
    }
  }
}
