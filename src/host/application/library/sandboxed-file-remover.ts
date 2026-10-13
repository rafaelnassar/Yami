/**
 * Deletes one regular file after resolving it through the path sandbox.
 * Shared by `files.delete` and `conversations.delete` so both apply the same
 * rules: never outside the download dir, never a directory, and a file that is
 * already gone counts as "missing" (not as a failure).
 */
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import type { FileSystemPort, PathSandbox } from '../ports/files.ts';

export type RemovalOutcome =
  | { readonly kind: 'deleted'; readonly resolvedPath: string }
  | { readonly kind: 'missing'; readonly resolvedPath: string | null }
  | { readonly kind: 'failed'; readonly error: AppErrorData };

export class SandboxedFileRemover {
  readonly #sandbox: Pick<PathSandbox, 'resolveInside'>;
  readonly #fs: Pick<FileSystemPort, 'stat' | 'removeFile'>;

  constructor(sandbox: Pick<PathSandbox, 'resolveInside'>, fs: Pick<FileSystemPort, 'stat' | 'removeFile'>) {
    this.#sandbox = sandbox;
    this.#fs = fs;
  }

  async remove(path: string): Promise<RemovalOutcome> {
    const resolved = await this.#sandbox.resolveInside(path, { mustExist: false });
    if (!resolved.ok) {
      return resolved.error.code === ErrorCode.PATH_NOT_FOUND
        ? { kind: 'missing', resolvedPath: null }
        : { kind: 'failed', error: resolved.error };
    }
    const target = resolved.value;
    const stat = await this.#fs.stat(target);
    if (!stat) return { kind: 'missing', resolvedPath: target };
    if (stat.isDirectory) return { kind: 'failed', error: appError(ErrorCode.PATH_INVALID, { reason: 'not-a-file' }) };
    const removed = await this.#fs.removeFile(target);
    if (removed.ok) return { kind: 'deleted', resolvedPath: target };
    return removed.error.code === ErrorCode.PATH_NOT_FOUND
      ? { kind: 'missing', resolvedPath: target }
      : { kind: 'failed', error: removed.error };
  }
}
