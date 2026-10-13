/**
 * Fakes for the filesystem ports. Paths are plain strings; the fake sandbox
 * treats `downloadDir` + either separator as "inside" and supports aliases to
 * simulate canonicalization (symlinks, case normalization).
 */
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { FileStat, FileSystemPort, LibraryScanner, PathSandbox, ScannedFile } from '../ports/files.ts';

interface Entry {
  readonly path: string;
  readonly stat: FileStat;
}

export class FakeFileSystem implements FileSystemPort {
  readonly #entries = new Map<string, Entry>();
  readonly #caseInsensitive: boolean;
  readonly removeFailures = new Map<string, AppErrorData>();
  readonly renameFailures = new Map<string, AppErrorData>();
  readonly removed: string[] = [];
  readonly renames: Array<{ from: string; to: string }> = [];

  constructor(options: { readonly caseInsensitive?: boolean } = {}) {
    this.#caseInsensitive = options.caseInsensitive ?? false;
  }

  addFile(path: string, sizeBytes = 10, modifiedAt = 1): this {
    this.#entries.set(this.#key(path), { path, stat: { sizeBytes, modifiedAt, isDirectory: false } });
    return this;
  }
  addDir(path: string): this {
    this.#entries.set(this.#key(path), { path, stat: { sizeBytes: 0, modifiedAt: 1, isDirectory: true } });
    return this;
  }
  has(path: string): boolean {
    return this.#entries.has(this.#key(path));
  }
  /** Stored spelling of a path (reveals the case after a case-only rename). */
  spelling(path: string): string | null {
    return this.#entries.get(this.#key(path))?.path ?? null;
  }

  async stat(path: string): Promise<FileStat | null> {
    return this.#entries.get(this.#key(path))?.stat ?? null;
  }
  async removeFile(path: string): Promise<Result<void, AppErrorData>> {
    const failure = this.removeFailures.get(path);
    if (failure) return err(failure);
    const entry = this.#entries.get(this.#key(path));
    if (!entry) return err(appError(ErrorCode.PATH_NOT_FOUND));
    if (entry.stat.isDirectory) return err(appError(ErrorCode.FILE_OPERATION_FAILED));
    this.#entries.delete(this.#key(path));
    this.removed.push(path);
    return ok();
  }
  async renameDirectory(from: string, to: string): Promise<Result<void, AppErrorData>> {
    const failure = this.renameFailures.get(to);
    if (failure) return err(failure);
    if (!this.has(from)) return err(appError(ErrorCode.PATH_NOT_FOUND));
    if (this.has(to)) return err(appError(ErrorCode.FILE_OPERATION_FAILED, { reason: 'exists' }));
    const fromKey = this.#key(from);
    for (const [key, entry] of [...this.#entries]) {
      const inside = key === fromKey || key.startsWith(`${fromKey}/`) || key.startsWith(`${fromKey}\\`);
      if (!inside) continue;
      this.#entries.delete(key);
      const moved = `${to}${entry.path.slice(from.length)}`;
      this.#entries.set(this.#key(moved), { path: moved, stat: entry.stat });
    }
    this.renames.push({ from, to });
    return ok();
  }
  async ensureDir(path: string): Promise<void> {
    if (!this.has(path)) this.addDir(path);
  }

  #key(path: string): string {
    return this.#caseInsensitive ? path.toLowerCase() : path;
  }
}

export class FakePathSandbox implements PathSandbox {
  downloadDir: string;
  /** input → canonical path (simulates realpath). */
  readonly aliases = new Map<string, string>();
  /** Inputs that must be rejected with the given error. */
  readonly rejections = new Map<string, AppErrorData>();
  readonly forbiddenDownloadDirs = new Set<string>();
  readonly #fs: FakeFileSystem;

  constructor(fs: FakeFileSystem, downloadDir = '/dl') {
    this.#fs = fs;
    this.downloadDir = downloadDir;
  }

  async resolveInside(
    input: string,
    options?: { readonly mustExist?: boolean }
  ): Promise<Result<string, AppErrorData>> {
    const rejection = this.rejections.get(input);
    if (rejection) return err(rejection);
    const canonical = (this.aliases.get(input) ?? input).replace(/[\\/]+$/, '');
    const root = this.downloadDir;
    const inside = canonical === root || canonical.startsWith(`${root}/`) || canonical.startsWith(`${root}\\`);
    if (!inside) return err(appError(ErrorCode.PATH_OUTSIDE_SANDBOX));
    if (options?.mustExist && !this.#fs.has(canonical)) return err(appError(ErrorCode.PATH_NOT_FOUND));
    return ok(canonical);
  }

  async validateDownloadDir(input: string): Promise<Result<string, AppErrorData>> {
    if (this.forbiddenDownloadDirs.has(input)) {
      return err(appError(ErrorCode.DOWNLOAD_DIR_FORBIDDEN, { reason: 'system' }));
    }
    return ok(input.replace(/[\\/]+$/, ''));
  }

  setDownloadDir(canonicalDir: string): void {
    this.downloadDir = canonicalDir;
  }
}

export class FakeLibraryScanner implements LibraryScanner {
  files: ScannedFile[] = [];
  invalidations = 0;
  readonly calls: Array<{ root: string; limit: number; cursor: string | null }> = [];

  async scan(
    root: string,
    limit: number,
    cursor: string | null
  ): Promise<{ files: ScannedFile[]; nextCursor: string | null }> {
    this.calls.push({ root, limit, cursor });
    const start = cursor ? Number(cursor) : 0;
    const end = start + limit;
    return { files: this.files.slice(start, end), nextCursor: end < this.files.length ? String(end) : null };
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}
