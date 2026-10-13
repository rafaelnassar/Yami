/**
 * Private scratch directories. The app temp dir must never be reachable by other local
 * users: a shared, world-writable location (Linux `/tmp`) lets another account pre-create
 * the directory and swap files we later load (the legacy probe page runs in the `file://`
 * origin; the host copies the legacy database there). Main therefore keeps it under
 * `userData` and insists on a real directory, owned by us, with mode 0700, before anything
 * is written to it.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger.ts';

export interface PrivateDirOptions {
  readonly platform: NodeJS.Platform;
  /** Effective uid (`process.getuid()`); `null` where uids do not exist (Windows). */
  readonly uid: number | null;
  readonly logger: Logger;
}

type DirStats = Pick<Stats, 'isDirectory' | 'isSymbolicLink' | 'uid' | 'mode'>;

/**
 * A symlink/junction or a non-directory is never private. On POSIX the directory must also
 * be ours and closed to group/others. Windows has no meaningful mode bits: the per-user
 * profile ACLs protect `userData`, so only the link/type checks apply there.
 */
export function isPrivateDir(info: DirStats, options: Pick<PrivateDirOptions, 'platform' | 'uid'>): boolean {
  if (info.isSymbolicLink() || !info.isDirectory()) return false;
  if (options.platform === 'win32' || options.uid === null) return true;
  return info.uid === options.uid && (info.mode & 0o077) === 0;
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Creates `dir` as 0700, or checks the existing entry; `true` when it is private. */
function makePrivate(dir: string, options: PrivateDirOptions): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 });
    // The umask can only remove bits; set the exact mode on the directory we just created.
    if (options.platform !== 'win32') chmodSync(dir, 0o700);
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
  }
  return isPrivateDir(lstatSync(dir), options);
}

/**
 * Ensures `dir` is a private directory and returns the directory to use. An existing entry
 * that is not private (symlink, file, foreign owner, group/other access) is removed —
 * without following links — and recreated. If that is impossible, a fresh random sibling
 * (`mkdtemp`, always 0700) is returned instead. Throws only when the parent is unusable.
 */
export function ensurePrivateDirSync(dir: string, options: PrivateDirOptions): string {
  mkdirSync(path.dirname(dir), { recursive: true });
  if (makePrivate(dir, options)) return dir;

  options.logger.warn('temp dir is not private; recreating it', { dir });
  try {
    // `rm` never follows symlinks: a planted link is unlinked, its target left alone.
    rmSync(dir, { recursive: true, force: true });
    if (makePrivate(dir, options)) return dir;
  } catch (error) {
    options.logger.warn('could not recreate the temp dir', { dir, error: String(error) });
  }
  const fallback = mkdtempSync(path.join(path.dirname(dir), `${path.basename(dir)}-`));
  options.logger.warn('using a fresh private temp dir', { dir: fallback });
  return fallback;
}
