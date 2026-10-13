/**
 * URLs the user dismissed from clipboard suggestions, stored only as SHA-256 hashes
 * (`userData/clipboard-dismissed.json`, newest last, max 500) — the file never reveals
 * which links were copied.
 */
import { createHash } from 'node:crypto';
import { readTextIfExists, writeFileAtomicSync } from '../../infrastructure/atomic-file.ts';
import { describeError, type Logger } from '../../infrastructure/logger.ts';
import { normalizeForHistory } from './clipboard-urls.ts';

const MAX_ENTRIES = 500;
const HASH = /^[a-f0-9]{64}$/;

export function hashUrl(url: string): string {
  return createHash('sha256')
    .update(normalizeForHistory(url) ?? url)
    .digest('hex');
}

export class DismissedUrls {
  readonly #file: string;
  readonly #logger: Logger;
  readonly #max: number;
  #hashes: string[] | null = null;

  constructor(file: string, logger: Logger, max = MAX_ENTRIES) {
    this.#file = file;
    this.#logger = logger;
    this.#max = max;
  }

  has(url: string): boolean {
    return this.#load().includes(hashUrl(url));
  }

  add(url: string): void {
    const hash = hashUrl(url);
    const hashes = this.#load().filter((entry) => entry !== hash);
    hashes.push(hash);
    this.#hashes = hashes.slice(-this.#max);
    try {
      writeFileAtomicSync(this.#file, JSON.stringify({ version: 1, hashes: this.#hashes }));
    } catch (error) {
      this.#logger.warn('could not persist dismissed clipboard URLs', describeError(error));
    }
  }

  #load(): string[] {
    if (this.#hashes) return this.#hashes;
    let hashes: string[] = [];
    try {
      const text = readTextIfExists(this.#file);
      const data: unknown = text ? JSON.parse(text) : null;
      const list = typeof data === 'object' && data !== null && 'hashes' in data ? data.hashes : null;
      if (Array.isArray(list))
        hashes = list.filter((entry): entry is string => typeof entry === 'string' && HASH.test(entry));
    } catch (error) {
      this.#logger.warn('dismissed clipboard URLs unreadable; starting empty', describeError(error));
    }
    this.#hashes = hashes.slice(-this.#max);
    return this.#hashes;
  }
}
