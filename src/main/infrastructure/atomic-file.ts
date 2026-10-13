/**
 * Crash-safe small-file persistence (settings, dismissals, vault key). Mirrors the host's
 * `security/atomic-file.ts`: private temp file in the same directory, fsync, rename over
 * the target, then fsync the directory where the platform supports it.
 *
 * `fs` is used through the module object (not named imports) so tests can observe the
 * durability calls with `mock.method`.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AtomicWriteOptions {
  /** File mode for the written file (e.g. `0o600` for secrets). */
  readonly mode?: number;
  /** Mode for directories created on the way. */
  readonly dirMode?: number;
  /**
   * fsync the file before the rename and the directory after it (default `true`), so a
   * power loss cannot leave an empty or missing file. Caches may opt out.
   */
  readonly durable?: boolean;
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 4;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * `renameSync` with a short retry loop: Windows antivirus/indexers may hold a transient
 * lock on the source or target (EPERM/EBUSY/EACCES).
 */
export function renameWithRetrySync(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = errnoCode(error);
      if (attempt >= RENAME_RETRIES || !code || !RETRYABLE.has(code)) throw error;
      sleepSync(25 * (attempt + 1));
    }
  }
}

/** Makes the rename durable on POSIX; Windows cannot open directories, so it is best effort. */
function syncDirectorySync(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* best effort: some platforms/filesystems do not support fsync on directories */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing left to do: the data is already renamed into place */
      }
    }
  }
}

/**
 * Writes `data` to a temp file in the same directory and renames it over the target,
 * so readers never observe a half-written file (see `AtomicWriteOptions.durable`).
 */
export function writeFileAtomicSync(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const durable = options.durable ?? true;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  // `wx`: the random name must not exist yet (never write through a planted file or link).
  const fd = fs.openSync(tmp, 'wx', options.mode ?? 0o666);
  try {
    try {
      fs.writeFileSync(fd, data);
      if (durable) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetrySync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  if (durable) syncDirectorySync(dir);
}

/** Reads a UTF-8 file, returning `null` when it does not exist. Other errors propagate. */
export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** Reads a binary file, returning `null` when it does not exist. */
export function readBytesIfExists(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
