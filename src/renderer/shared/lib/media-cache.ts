/**
 * Cache of `yami-media://` URLs for thumbnails and previews.
 *
 * - LRU with a TTL shorter than main's URL lifetime (URLs expire in main); both
 *   limits come from `MEDIA_URL_LIMITS`, so main's token table outlasts this cache.
 * - A URL that fails to load anyway (token evicted/expired in main, file replaced)
 *   is dropped with `forget` and fetched again (see `useMediaUrl`).
 * - Concurrent requests for the same key share one in-flight promise.
 * - At most `concurrency` bridge calls run at once so fast scrolling through a
 *   large grid does not flood IPC; queued requests that are no longer wanted
 *   can be cancelled with the returned `cancel`.
 */
import { MEDIA_URL_LIMITS, type IpcResult, type MediaUrlDto } from '../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';

export type ThumbnailSize = 'small' | 'large';

/** The size is part of the kind, so small and large thumbnails of one file are cached separately. */
export type MediaKind = 'thumbnail-small' | 'thumbnail-large' | 'preview';

export function thumbnailKind(size: ThumbnailSize): MediaKind {
  return size === 'large' ? 'thumbnail-large' : 'thumbnail-small';
}

/** Longest edge of main's small thumbnails (`THUMBNAIL_EDGE.small` in main's media service). */
export const SMALL_THUMBNAIL_EDGE = 320;

/** Large thumbnails when a tile is wider (in device pixels) than the small rendition. */
export function thumbnailSizeFor(cssWidth: number, devicePixelRatio: number): ThumbnailSize {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return cssWidth * ratio > SMALL_THUMBNAIL_EDGE ? 'large' : 'small';
}

/** A view that refetched a file after a load error and fails again within this window gives up. */
export const LOAD_RETRY_COOLDOWN_MS = 60_000;

export interface LoadRetry {
  /** A load of `fileKey` failed: `true` to refetch, `false` when this view refetched it less than the cooldown ago. */
  readonly allow: (fileKey: string) => boolean;
}

/**
 * Retry budget of one view (see `useMediaUrl`): one refetch per file per cooldown window. A window rather than
 * "once ever" lets a view that stays open recover again later (a token that reached its maximum age, a download
 * folder change), while a file that fails right after a refetch is reported instead of looping.
 */
export function createLoadRetry(now: () => number, cooldownMs = LOAD_RETRY_COOLDOWN_MS): LoadRetry {
  let last: { readonly key: string; readonly at: number } | null = null;
  return {
    allow(fileKey) {
      const at = now();
      if (last !== null && last.key === fileKey && at - last.at < cooldownMs) return false;
      last = { key: fileKey, at };
      return true;
    }
  };
}

export type MediaFetcher = (kind: MediaKind, path: string) => Promise<IpcResult<MediaUrlDto>>;

export interface MediaCacheOptions {
  readonly fetcher: MediaFetcher;
  readonly now: () => number;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly concurrency?: number;
}

export type MediaLookup =
  { readonly ok: true; readonly media: MediaUrlDto } | { readonly ok: false; readonly error: AppErrorData };

interface Entry {
  readonly media: MediaUrlDto;
  readonly at: number;
}

interface Job {
  readonly key: string;
  readonly kind: MediaKind;
  readonly path: string;
  readonly waiters: Set<(result: MediaLookup) => void>;
  started: boolean;
}

export interface MediaUrlCache {
  peek(kind: MediaKind, path: string): MediaUrlDto | null;
  /** Resolves through `onResult` (once). Returns a canceller for callers that unmount first. */
  get(kind: MediaKind, path: string, onResult: (result: MediaLookup) => void): () => void;
  /** Drops cached URLs for deleted/renamed files. */
  invalidate(paths: readonly string[]): void;
  /**
   * Drops the cached URL of `kind`/`path` if it is still `url`, a URL that failed to load, so the
   * next `get` asks main again. A newer URL cached meanwhile (another view already refetched) is kept.
   */
  forget(kind: MediaKind, path: string, url: string): void;
  readonly size: number;
}

export function createMediaUrlCache(options: MediaCacheOptions): MediaUrlCache {
  const maxEntries = options.maxEntries ?? MEDIA_URL_LIMITS.cacheEntries;
  const ttlMs = options.ttlMs ?? MEDIA_URL_LIMITS.cacheTtlMs;
  const concurrency = options.concurrency ?? 6;
  const entries = new Map<string, Entry>();
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let running = 0;

  const keyOf = (kind: MediaKind, path: string): string => `${kind}\u0000${path}`;

  const peekKey = (key: string): MediaUrlDto | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (options.now() - entry.at > ttlMs) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.media;
  };

  const remember = (key: string, media: MediaUrlDto): void => {
    entries.delete(key);
    entries.set(key, { media, at: options.now() });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const pump = (): void => {
    while (running < concurrency) {
      const job = queue.shift();
      if (!job) return;
      if (job.waiters.size === 0) {
        jobs.delete(job.key);
        continue;
      }
      job.started = true;
      running += 1;
      void options
        .fetcher(job.kind, job.path)
        .then(
          (result): MediaLookup => (result.ok ? { ok: true, media: result.data } : { ok: false, error: result.error }),
          (error: unknown): MediaLookup => ({
            ok: false,
            error: { code: 'INTERNAL', params: { detail: String(error) } }
          })
        )
        .then((lookup) => {
          running -= 1;
          jobs.delete(job.key);
          if (lookup.ok) remember(job.key, lookup.media);
          for (const waiter of job.waiters) waiter(lookup);
          pump();
        });
    }
  };

  return {
    peek: (kind, path) => peekKey(keyOf(kind, path)),
    get(kind, path, onResult) {
      const key = keyOf(kind, path);
      const cached = peekKey(key);
      if (cached) {
        onResult({ ok: true, media: cached });
        return () => undefined;
      }
      let job = jobs.get(key);
      if (!job) {
        job = { key, kind, path, waiters: new Set(), started: false };
        jobs.set(key, job);
        queue.push(job);
      }
      const current = job;
      let done = false;
      const waiter = (result: MediaLookup): void => {
        if (done) return;
        done = true;
        onResult(result);
      };
      current.waiters.add(waiter);
      pump();
      return () => {
        done = true;
        current.waiters.delete(waiter);
      };
    },
    invalidate(paths) {
      const set = new Set(paths);
      for (const key of [...entries.keys()]) {
        const path = key.slice(key.indexOf('\u0000') + 1);
        if (set.has(path)) entries.delete(key);
      }
    },
    forget(kind, path, url) {
      const key = keyOf(kind, path);
      if (entries.get(key)?.media.url === url) entries.delete(key);
    },
    get size() {
      return entries.size;
    }
  };
}
