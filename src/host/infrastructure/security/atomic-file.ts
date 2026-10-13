/**
 * Crash-safe file replacement for small secret files: write a private temp file
 * in the same directory, fsync it, rename over the target, then fsync the
 * directory (POSIX). Files are created with mode 0600.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export interface AtomicWriteOptions {
  /** File mode for the new file (default 0600). */
  readonly mode?: number;
  /** Directory mode when it must be created (default 0700). */
  readonly dirMode?: number;
}

const RENAME_RETRIES = 4;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows reports EPERM/EACCES/EBUSY while another process (AV, indexer) holds the target.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function syncDirectory(dir: string): Promise<void> {
  // Makes the rename durable on POSIX; Windows cannot open directories and just fails here.
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* best effort: some filesystems do not support fsync on directories */
  }
}

export async function writeFileAtomic(
  file: string,
  data: Buffer | string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', mode);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The umask may have narrowed or (on some systems) widened the mode.
    await chmod(temp, mode).catch(() => undefined);
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dir);
}
