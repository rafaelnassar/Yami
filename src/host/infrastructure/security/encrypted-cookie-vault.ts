/**
 * `CookieVault` storing each Netscape cookie file encrypted at
 * `<dataDir>/vault/cookies/<name>.enc`. Plaintext only exists in memory and in
 * the per-download copies written by `materialize` (0600, inside the private
 * job directory, deleted by the job workspace).
 *
 * `absorb` is a compare-and-swap on a per-cookie generation: only the user's
 * `save`/`remove` bump it (an absorb does not), `materialize` records it for each
 * copy, and the engine's update is written back (inside the write mutex) only
 * while the generation is unchanged. A cookie file re-imported or removed while a
 * download ran is therefore never replaced by the job's stale copy, while jobs
 * sharing a cookie stay last-writer-wins (yt-dlp rewrites its cookie file on exit,
 * so the job that finishes last holds the freshest session). A copy the engine
 * did not change is never written back.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Mutex } from '../../../shared/kernel/async.ts';
import { systemClock, type Clock } from '../../../shared/kernel/clock.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { CookieFileDto } from '../../../shared/contracts/dto.ts';
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';
import type { CookieVault } from '../../application/ports/secrets.ts';
import type { Logger } from '../../application/ports/system.ts';
import { describeError, silentLogger } from '../persistence/silent-logger.ts';
import { writeFileAtomic } from './atomic-file.ts';
import { parseNetscapeCookies } from './cookie-format.ts';
import { isValidCookieName, validateCookieName } from './cookie-name.ts';
import { SECRET_BOX_OVERHEAD, type SecretBox } from './secret-box.ts';

const EXTENSION = '.enc';
/**
 * Materialized copies remembered for `absorb`. Runs that never absorb (launch
 * failures, discarded or retried runs, the legacy cleanup) leave an entry behind
 * whose copy file is deleted with the job's secrets, so on overflow entries whose
 * copy no longer exists go first. Only past that (more live copies than this,
 * never reached with the slot budget) the oldest entry is dropped and its copy is
 * simply not written back.
 */
const MAX_TRACKED_COPIES = 256;

/** What `materialize` handed to one per-job copy. */
interface HandedOutCopy {
  readonly name: string;
  /** Cookie generation when the copy was made (see `#generations`). */
  readonly generation: number;
  /** SHA-256 of the plaintext handed out (an unchanged copy is not written back). */
  readonly sha256: string;
}

/**
 * Generation key of a cookie name. Case-insensitive like the Windows/macOS file
 * systems the vault lives on; on a case-sensitive one, `X.txt` and `x.txt` share a
 * counter, which at worst skips one session refresh (never overwrites a re-import).
 */
function generationKey(name: string): string {
  return name.toLowerCase();
}

function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface EncryptedCookieVaultOptions {
  readonly dataDir: string;
  readonly box: SecretBox;
  readonly logger?: Logger;
  readonly clock?: Clock;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function byName(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class EncryptedCookieVault implements CookieVault {
  readonly #dir: string;
  readonly #box: SecretBox;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #writes = new Mutex();
  /** Resolved copy path → what `materialize` handed out (insertion order = age). */
  readonly #handedOut = new Map<string, HandedOutCopy>();
  /** Bumped by the user's `save`/`remove` of a cookie (never by `absorb`); missing = 0. */
  readonly #generations = new Map<string, number>();

  constructor(options: EncryptedCookieVaultOptions) {
    this.#dir = path.join(options.dataDir, 'vault', 'cookies');
    this.#box = options.box;
    this.#logger = (options.logger ?? silentLogger()).child({ component: 'cookie-vault' });
    this.#clock = options.clock ?? systemClock;
  }

  async list(): Promise<CookieFileDto[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const names = entries
      .filter((entry) => entry.endsWith(EXTENSION))
      .map((entry) => entry.slice(0, -EXTENSION.length))
      .filter(isValidCookieName)
      .sort(byName);
    const out: CookieFileDto[] = [];
    for (const name of names) {
      const dto = await this.#describe(name);
      if (dto) out.push(dto);
    }
    return out;
  }

  async exists(name: string): Promise<boolean> {
    if (!isValidCookieName(name)) return false;
    try {
      return (await stat(this.#file(name))).isFile();
    } catch {
      return false;
    }
  }

  async save(name: string, content: string): Promise<Result<CookieFileDto, AppErrorData>> {
    const valid = validateCookieName(name);
    if (!valid.ok) return valid;
    const parsed = parseNetscapeCookies(content);
    if (!parsed.ok) return parsed;
    await this.#writes.runExclusive(async () => {
      try {
        await writeFileAtomic(this.#file(name), this.#encrypt(name, content));
      } finally {
        this.#bumpGeneration(name); // even on failure: a half-known state must not be overwritten by a job
      }
    });
    const info = await stat(this.#file(name));
    return ok({
      name,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      updatedAt: Math.trunc(info.mtimeMs) || this.#clock.now(),
      domains: parsed.value.domains
    });
  }

  async remove(name: string): Promise<Result<void, AppErrorData>> {
    const valid = validateCookieName(name);
    if (!valid.ok) return valid;
    return this.#writes.runExclusive(async () => {
      try {
        await rm(this.#file(name));
        return ok();
      } catch (error) {
        if (isNotFound(error)) return err(appError(ErrorCode.COOKIES_NOT_FOUND));
        throw error;
      } finally {
        this.#bumpGeneration(name);
      }
    });
  }

  async materialize(name: string, targetDir: string): Promise<Result<string, AppErrorData>> {
    // Read the generation before the content: a save in between then only costs this job's refresh.
    const generation = this.#generationOf(name);
    const plaintext = await this.#read(name);
    if (!plaintext.ok) return plaintext;
    const target = path.join(targetDir, name);
    await writeFileAtomic(target, plaintext.value, { mode: 0o600, dirMode: 0o700 });
    await this.#remember(target, { name, generation, sha256: sha256Of(plaintext.value) });
    return ok(target);
  }

  async absorb(name: string, updatedFile: string): Promise<void> {
    const key = path.resolve(updatedFile);
    const handedOut = this.#handedOut.get(key);
    // One absorb per materialized copy: the job is over once its copy is committed or dropped.
    this.#handedOut.delete(key);
    try {
      if (!isValidCookieName(name)) return;
      if (handedOut?.name !== name) {
        // Not materialized by this vault instance (or evicted): what the job started from is unknown.
        this.#logger.debug('not absorbing an untracked cookie copy', { name });
        return;
      }
      const info = await stat(updatedFile).catch(() => null);
      if (!info?.isFile() || info.size > LIMITS.maxCookieFileBytes) return;
      const bytes = await readFile(updatedFile);
      if (sha256Of(bytes) === handedOut.sha256) return; // the engine did not change it
      const content = bytes.toString('utf8');
      if (!parseNetscapeCookies(content).ok) {
        this.#logger.warn('ignoring updated cookie file with invalid format', { name });
        return;
      }
      await this.#writes.runExclusive(async () => {
        if (this.#generationOf(name) !== handedOut.generation) {
          this.#logger.info('cookie file re-imported or removed while the download ran; keeping it', { name });
          return;
        }
        // Deleted outside the app meanwhile: never resurrect it.
        if (!(await this.exists(name))) return;
        await writeFileAtomic(this.#file(name), this.#encrypt(name, content));
      });
    } catch (error) {
      this.#logger.warn('failed to absorb updated cookie file', { name, error: describeError(error) });
    }
  }

  async domainsOf(name: string): Promise<readonly string[]> {
    const plaintext = await this.#read(name);
    if (!plaintext.ok) return [];
    const parsed = parseNetscapeCookies(plaintext.value.toString('utf8'));
    return parsed.ok ? parsed.value.domains : [];
  }

  #file(name: string): string {
    return path.join(this.#dir, `${name}${EXTENSION}`);
  }

  #generationOf(name: string): number {
    return this.#generations.get(generationKey(name)) ?? 0;
  }

  #bumpGeneration(name: string): void {
    this.#generations.set(generationKey(name), this.#generationOf(name) + 1);
  }

  async #remember(copy: string, handedOut: HandedOutCopy): Promise<void> {
    const key = path.resolve(copy);
    this.#handedOut.delete(key); // re-materializing (resume) refreshes the entry and its age
    this.#handedOut.set(key, handedOut);
    if (this.#handedOut.size <= MAX_TRACKED_COPIES) return;
    await this.#forgetReleasedCopies();
    for (const oldest of this.#handedOut.keys()) {
      if (this.#handedOut.size <= MAX_TRACKED_COPIES) break;
      this.#handedOut.delete(oldest);
    }
  }

  /** Drops entries whose copy file is gone (its job released the secrets without absorbing). */
  async #forgetReleasedCopies(): Promise<void> {
    const entries = [...this.#handedOut];
    const gone = await Promise.all(entries.map(async ([copy]) => (await lstat(copy).catch(() => null)) === null));
    entries.forEach(([copy, entry], index) => {
      // Only if not re-materialized meanwhile (a fresh entry is a new object).
      if (gone[index] && this.#handedOut.get(copy) === entry) this.#handedOut.delete(copy);
    });
  }

  #encrypt(name: string, content: string): Buffer {
    return this.#box.encrypt(content, `cookie:${name}`);
  }

  async #read(name: string): Promise<Result<Buffer, AppErrorData>> {
    const valid = validateCookieName(name);
    if (!valid.ok) return valid;
    let blob: Buffer;
    try {
      blob = await readFile(this.#file(name));
    } catch (error) {
      if (isNotFound(error)) return err(appError(ErrorCode.COOKIES_NOT_FOUND));
      throw error;
    }
    const plaintext = this.#box.decrypt(blob, `cookie:${name}`);
    if (!plaintext.ok) this.#logger.warn('cookie file could not be decrypted', { name });
    return plaintext;
  }

  async #describe(name: string): Promise<CookieFileDto | null> {
    try {
      const info = await stat(this.#file(name));
      if (!info.isFile()) return null;
      const plaintext = await this.#read(name);
      // Undecryptable entries (e.g. the OS keychain was reset) stay listed so the user can delete them.
      const content = plaintext.ok ? plaintext.value.toString('utf8') : null;
      const parsed = content === null ? null : parseNetscapeCookies(content);
      return {
        name,
        sizeBytes: content === null ? Math.max(0, info.size - SECRET_BOX_OVERHEAD) : Buffer.byteLength(content, 'utf8'),
        updatedAt: Math.trunc(info.mtimeMs),
        domains: parsed?.ok ? parsed.value.domains : []
      };
    } catch (error) {
      if (!isNotFound(error)) this.#logger.warn('failed to read cookie file', { name, error: describeError(error) });
      return null;
    }
  }
}
