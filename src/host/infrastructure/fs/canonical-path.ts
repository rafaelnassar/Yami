/**
 * Canonicalization for paths that may not exist yet: realpath the deepest
 * existing ancestor and re-append the missing tail. Symlinks/junctions in the
 * existing part are resolved, so containment checks see where data really goes.
 */
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { type AppErrorData, ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { PathModule } from './path-rules.ts';

/** File-system operations the sandbox needs (injectable so win32 logic runs on Linux). */
export interface SandboxFileSystem {
  /** Throws an error with `code` (`ENOENT`, `ENOTDIR`, `ELOOP`…) when it cannot resolve. */
  realpath(path: string): Promise<string>;
  /** True when an entry (even a dangling symlink) exists at `path`. */
  entryExists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  /** Owner and mode bits of an existing entry (following links); `null` when it cannot be read. POSIX only. */
  ownership(path: string): Promise<EntryOwnership | null>;
}

export interface EntryOwnership {
  readonly uid: number;
  readonly mode: number;
}

export class NodeSandboxFileSystem implements SandboxFileSystem {
  realpath(path: string): Promise<string> {
    return realpath(path);
  }

  entryExists(path: string): Promise<boolean> {
    return lstat(path).then(
      () => true,
      () => false
    );
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  ownership(path: string): Promise<EntryOwnership | null> {
    return stat(path).then(
      (info) => ({ uid: info.uid, mode: info.mode }),
      () => null
    );
  }
}

export interface CanonicalPath {
  readonly path: string;
  /** False when some trailing segments do not exist (yet). */
  readonly exists: boolean;
}

export function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export async function canonicalize(
  target: string,
  mod: PathModule,
  fs: SandboxFileSystem
): Promise<Result<CanonicalPath, AppErrorData>> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return ok({ path: tail.length > 0 ? mod.join(real, ...tail.reverse()) : real, exists: tail.length === 0 });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return err(appError(ErrorCode.PATH_INVALID, { reason: code ?? 'unresolvable' }));
      }
      // realpath failed but an entry exists: a dangling symlink whose target could be anywhere.
      if (code === 'ENOENT' && (await fs.entryExists(current))) {
        return err(appError(ErrorCode.PATH_INVALID, { reason: 'dangling-link' }));
      }
      const parent = mod.dirname(current);
      if (parent === current) return ok({ path: target, exists: false });
      tail.push(mod.basename(current));
      current = parent;
    }
  }
}
