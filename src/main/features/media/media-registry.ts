/**
 * Short-lived capability tokens for `yami-media://` URLs. A token maps to one file the
 * host already validated (inside the download dir, previewable media type) and to the
 * identity that file had at that moment (re-checked per request by the protocol handler).
 *
 * Tokens are unguessable and expire after `MEDIA_URL_LIMITS.tokenTtlMs` without use, and in
 * any case `MEDIA_URL_LIMITS.tokenMaxAgeMs` after they were issued. Asking again for an
 * unchanged file (same path, mime, name and identity) returns its live token instead of
 * minting a new one, so URLs the renderers cached stay valid — unless the token is too close
 * to its maximum age to outlive a renderer's cached copy, then a fresh one is issued. The
 * table is an LRU capped at `MEDIA_URL_LIMITS.tokenEntries`, well above what the renderers
 * cache. `clear()` revokes everything (the download folder changed, see `download-dir-watch.ts`).
 */
import { randomBytes } from 'node:crypto';
import { MEDIA_URL_LIMITS } from '../../../shared/contracts/ipc.ts';
import type { MediaFileIdentity } from './media-identity.ts';

export interface MediaEntry {
  /** The validated path, resolved again on every request. */
  readonly path: string;
  readonly mime: string;
  readonly name: string;
  readonly identity: MediaFileIdentity;
}

export interface MediaRegistryOptions {
  readonly now: () => number;
  /** Sliding lifetime: a token dies this long after its last use. */
  readonly ttlMs?: number;
  /** Absolute lifetime from issue, however often the token is used. */
  readonly maxAgeMs?: number;
  /** A live token is handed out again only if it has at least this much absolute lifetime left. */
  readonly reuseMarginMs?: number;
  readonly maxEntries?: number;
  readonly newToken?: () => string;
}

type StoredEntry = MediaEntry & {
  /** Sliding expiry, never later than `diesAt`. */
  readonly expiresAt: number;
  /** Absolute expiry (issue time + max age). */
  readonly diesAt: number;
};

/** The file a token serves; at most one live token is reused per key. */
function fileKeyOf(entry: MediaEntry): string {
  return JSON.stringify([entry.path, entry.mime]);
}

function isSameEntry(a: MediaEntry, b: MediaEntry): boolean {
  const x = a.identity;
  const y = b.identity;
  return (
    a.path === b.path &&
    a.mime === b.mime &&
    a.name === b.name &&
    x.realPath === y.realPath &&
    x.dev === y.dev &&
    x.ino === y.ino &&
    x.size === y.size &&
    x.mtimeNs === y.mtimeNs
  );
}

export class MediaRegistry {
  /** Map order is recency order: the first entry is the least recently used. */
  readonly #entries = new Map<string, StoredEntry>();
  /** Latest token issued per file (`fileKeyOf`). */
  readonly #byFile = new Map<string, string>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxAgeMs: number;
  readonly #reuseMarginMs: number;
  readonly #max: number;
  readonly #newToken: () => string;
  #generation = 0;

  constructor(options: MediaRegistryOptions) {
    this.#now = options.now;
    this.#ttlMs = options.ttlMs ?? MEDIA_URL_LIMITS.tokenTtlMs;
    this.#maxAgeMs = options.maxAgeMs ?? MEDIA_URL_LIMITS.tokenMaxAgeMs;
    this.#reuseMarginMs = options.reuseMarginMs ?? MEDIA_URL_LIMITS.cacheTtlMs;
    this.#max = Math.max(1, options.maxEntries ?? MEDIA_URL_LIMITS.tokenEntries);
    this.#newToken = options.newToken ?? (() => randomBytes(16).toString('hex'));
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Bumped by `clear()`: a file validated before a clear must be validated again before registering. */
  get generation(): number {
    return this.#generation;
  }

  register(entry: MediaEntry): string {
    this.#prune();
    const now = this.#now();
    const fileKey = fileKeyOf(entry);
    const live = this.#byFile.get(fileKey);
    const current = live === undefined ? undefined : this.#entries.get(live);
    if (
      live !== undefined &&
      current !== undefined &&
      current.expiresAt > now &&
      current.diesAt - now >= this.#reuseMarginMs &&
      isSameEntry(current, entry)
    ) {
      // Same file, unchanged since the token was issued: keep handing out the same URL.
      this.#touch(live, current);
      return live;
    }
    // Evict before inserting so the table never exceeds the cap (legacy briefly held cap+1).
    while (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#delete(oldest.value);
    }
    // An older token of the same file (near its maximum age) stays valid until it expires.
    const token = this.#newToken();
    const diesAt = now + this.#maxAgeMs;
    this.#entries.set(token, { ...entry, expiresAt: Math.min(now + this.#ttlMs, diesAt), diesAt });
    this.#byFile.set(fileKey, token);
    return token;
  }

  resolve(token: string): MediaEntry | null {
    const entry = this.#entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#delete(token);
      return null;
    }
    // A token in use (a playing video keeps issuing range requests) stays alive and is evicted last.
    this.#touch(token, entry);
    return entry;
  }

  /** Revokes every token (thumbnails included). */
  clear(): void {
    this.#entries.clear();
    this.#byFile.clear();
    this.#generation += 1;
  }

  /** Marks the token as most recently used and restarts its sliding lifetime (capped by its maximum age). */
  #touch(token: string, entry: StoredEntry): void {
    this.#entries.delete(token);
    this.#entries.set(token, { ...entry, expiresAt: Math.min(this.#now() + this.#ttlMs, entry.diesAt) });
  }

  #delete(token: string): void {
    const entry = this.#entries.get(token);
    this.#entries.delete(token);
    if (entry && this.#byFile.get(fileKeyOf(entry)) === token) this.#byFile.delete(fileKeyOf(entry));
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#delete(token);
    }
  }
}
