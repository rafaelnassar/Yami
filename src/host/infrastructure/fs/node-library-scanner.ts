/**
 * `LibraryScanner`: async, iterative walk of the download directory listing
 * media files newest-first, with a short per-root cache so paging is stable.
 *
 * Unlike the legacy scan (first 25 000 files in directory order), the cap keeps
 * the NEWEST files of the whole tree, and the event loop is never blocked.
 */
import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { LibraryScanner, ScannedFile } from '../../application/ports/files.ts';
import { type Clock, systemClock } from '../../../shared/kernel/clock.ts';
import { isSidecarFile, mediaTypeOf } from '../../../shared/domain/media.ts';

export interface NodeLibraryScannerOptions {
  readonly clock?: Clock;
  /** Cache lifetime per root (default 30 s). */
  readonly cacheTtlMs?: number;
  /** Max files kept (newest first, default 50 000). */
  readonly maxFiles?: number;
  /** Max directory depth below the root (default 32). */
  readonly maxDepth?: number;
}

interface CacheEntry {
  readonly files: readonly ScannedFile[];
  readonly at: number;
}

const STAT_CONCURRENCY = 32;

/** yt-dlp intermediates: `x.mp4.part`, `x.part-Frag12`, `x.f137.mp4`, `x.temp.mp4`, `x.ytdl`. */
const ENGINE_TEMP =
  /(?:\.part(?:-Frag\d+)?|\.ytdl|\.temp(?:\.[^.]+)?|\.f\d+(?:-\d+)?\.(?:mp4|webm|m4a|mkv|mp3|ogg|opus|aac|flv|3gp|ts))$/i;

export function isLibraryMedia(name: string): boolean {
  if (name.startsWith('.') || ENGINE_TEMP.test(name) || isSidecarFile(name)) return false;
  const type = mediaTypeOf(name);
  return type === 'image' || type === 'video' || type === 'audio';
}

function newestFirst(a: ScannedFile, b: ScannedFile): number {
  return b.modifiedAt - a.modifiedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const offset = typeof parsed === 'object' && parsed !== null ? (parsed as { o?: unknown }).o : undefined;
    return typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export class NodeLibraryScanner implements LibraryScanner {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #maxFiles: number;
  readonly #maxDepth: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<readonly ScannedFile[]>>();
  #generation = 0;

  constructor(options: NodeLibraryScannerOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#ttlMs = options.cacheTtlMs ?? 30_000;
    this.#maxFiles = options.maxFiles ?? 50_000;
    this.#maxDepth = options.maxDepth ?? 32;
  }

  async scan(
    root: string,
    limit: number,
    cursor: string | null
  ): Promise<{ readonly files: readonly ScannedFile[]; readonly nextCursor: string | null }> {
    const files = await this.#list(path.resolve(root));
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), this.#maxFiles)) : 1;
    const offset = Math.min(decodeCursor(cursor), files.length);
    const end = Math.min(offset + size, files.length);
    return { files: files.slice(offset, end), nextCursor: end < files.length ? encodeCursor(end) : null };
  }

  invalidate(): void {
    this.#generation += 1;
    this.#cache.clear();
    this.#inFlight.clear();
  }

  #list(root: string): Promise<readonly ScannedFile[]> {
    const cached = this.#cache.get(root);
    if (cached && this.#clock.now() - cached.at <= this.#ttlMs) return Promise.resolve(cached.files);
    const running = this.#inFlight.get(root);
    if (running) return running;
    const generation = this.#generation;
    const task = this.#walk(root).then(
      (files) => {
        // A scan started before invalidate() must not repopulate the cache with stale data.
        if (generation === this.#generation) {
          this.#cache.set(root, { files, at: this.#clock.now() });
          this.#inFlight.delete(root);
        }
        return files;
      },
      (error: unknown) => {
        if (generation === this.#generation) this.#inFlight.delete(root);
        throw error;
      }
    );
    this.#inFlight.set(root, task);
    return task;
  }

  async #walk(root: string): Promise<readonly ScannedFile[]> {
    let collected: ScannedFile[] = [];
    const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop() ?? { dir: root, depth: 0 };
      const found = await this.#readDirectory(root, dir, depth, stack);
      collected.push(...found);
      // Trim periodically: keep only the newest `maxFiles` without holding the whole tree.
      if (collected.length > this.#maxFiles * 2) collected = collected.sort(newestFirst).slice(0, this.#maxFiles);
    }
    return collected.sort(newestFirst).slice(0, this.#maxFiles);
  }

  async #readDirectory(
    root: string,
    dir: string,
    depth: number,
    stack: { dir: string; depth: number }[]
  ): Promise<ScannedFile[]> {
    const candidates: string[] = [];
    try {
      const handle = await opendir(dir);
      for await (const entry of handle) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < this.#maxDepth) stack.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile() && isLibraryMedia(entry.name)) {
          candidates.push(full);
        }
      }
    } catch {
      return []; // unreadable or vanished directory: skip it
    }
    const out: ScannedFile[] = [];
    for (let i = 0; i < candidates.length; i += STAT_CONCURRENCY) {
      const batch = candidates.slice(i, i + STAT_CONCURRENCY);
      const stats = await Promise.all(batch.map((file) => lstat(file).catch(() => null)));
      stats.forEach((info, index) => {
        const file = batch[index];
        if (!info || !file || !info.isFile()) return;
        out.push({
          path: file,
          relativePath: path.relative(root, file),
          name: path.basename(file).normalize('NFC'),
          sizeBytes: info.size,
          modifiedAt: info.mtimeMs || info.ctimeMs
        });
      });
    }
    return out;
  }
}
