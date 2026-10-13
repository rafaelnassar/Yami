/**
 * `FileSystemPort` on `node:fs/promises`. Callers pass paths already vetted by
 * the `PathSandbox`; this adapter adds the type/existence guards.
 */
import { lstat, mkdir, rename, stat, unlink } from 'node:fs/promises';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { FileStat, FileSystemPort } from '../../application/ports/files.ts';
import { type AppErrorData, ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { errorCodeOf } from './canonical-path.ts';
import { foldCase, pathModuleFor, type PathModule } from './path-rules.ts';

export interface NodeFileSystemOptions {
  readonly platform: HostPlatform;
}

function failed(error: unknown, operation: string): AppErrorData {
  return appError(ErrorCode.FILE_OPERATION_FAILED, { operation, detail: errorCodeOf(error) ?? 'unknown' });
}

function isMissing(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class NodeFileSystem implements FileSystemPort {
  readonly #platform: HostPlatform;
  readonly #path: PathModule;

  constructor(options: NodeFileSystemOptions) {
    this.#platform = options.platform;
    this.#path = pathModuleFor(options.platform);
  }

  /** `null` when the entry does not exist or cannot be read. */
  async stat(path: string): Promise<FileStat | null> {
    try {
      const info = await stat(path);
      return { sizeBytes: info.size, modifiedAt: info.mtimeMs, isDirectory: info.isDirectory() };
    } catch {
      return null;
    }
  }

  async removeFile(path: string): Promise<Result<void, AppErrorData>> {
    try {
      const info = await lstat(path);
      if (info.isDirectory())
        return err(appError(ErrorCode.FILE_OPERATION_FAILED, { operation: 'remove', detail: 'EISDIR' }));
      await unlink(path);
      return ok();
    } catch (error) {
      if (isMissing(error)) return err(appError(ErrorCode.PATH_NOT_FOUND));
      return err(failed(error, 'remove'));
    }
  }

  async renameDirectory(from: string, to: string): Promise<Result<void, AppErrorData>> {
    const mod = this.#path;
    if (
      foldCase(mod.dirname(mod.resolve(from)), this.#platform) !==
      foldCase(mod.dirname(mod.resolve(to)), this.#platform)
    ) {
      return err(appError(ErrorCode.PATH_INVALID, { reason: 'different-parent' }));
    }
    let source;
    try {
      source = await lstat(from);
    } catch (error) {
      return err(isMissing(error) ? appError(ErrorCode.PATH_NOT_FOUND) : failed(error, 'rename'));
    }
    if (!source.isDirectory()) return err(appError(ErrorCode.PATH_NOT_FOUND));
    try {
      const target = await lstat(to);
      // Same inode = case-only rename on a case-insensitive file system (legacy refused it).
      const sameEntry = target.dev === source.dev && target.ino === source.ino && target.ino !== 0;
      if (!sameEntry || mod.resolve(from) === mod.resolve(to)) return err(appError(ErrorCode.FOLDER_ALREADY_EXISTS));
    } catch (error) {
      if (!isMissing(error)) return err(failed(error, 'rename'));
    }
    try {
      await rename(from, to);
      return ok();
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === 'EEXIST' || code === 'ENOTEMPTY') return err(appError(ErrorCode.FOLDER_ALREADY_EXISTS));
      if (isMissing(error)) return err(appError(ErrorCode.PATH_NOT_FOUND));
      return err(failed(error, 'rename'));
    }
  }

  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
