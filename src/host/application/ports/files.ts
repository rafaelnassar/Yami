/**
 * Filesystem ports (implemented by `host/infrastructure/fs`).
 */
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';

export interface PathSandbox {
  /** Current canonical download directory. */
  readonly downloadDir: string;
  /**
   * Resolves a user/renderer-supplied path to its canonical (realpath) form and
   * checks it is inside the download dir and not inside a protected directory
   * (app data, runtime, resources). Rejects NUL, ADS (`file:stream`), device and
   * `\\?\`/`\\.\` prefixes, reserved names; case-insensitive on Windows.
   */
  resolveInside(input: string, options?: { readonly mustExist?: boolean }): Promise<Result<string, AppErrorData>>;
  /**
   * Validates a candidate download directory: absolute, not a disk root, not a
   * system directory, and it must neither be inside nor CONTAIN any protected
   * directory (e.g. choosing the home folder that contains app data is rejected).
   * Returns the canonical path (created when missing).
   */
  validateDownloadDir(input: string): Promise<Result<string, AppErrorData>>;
  setDownloadDir(canonicalDir: string): void;
}

export interface FileStat {
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly isDirectory: boolean;
}

export interface FileSystemPort {
  stat(path: string): Promise<FileStat | null>;
  /** Deletes a regular file (never a directory). */
  removeFile(path: string): Promise<Result<void, AppErrorData>>;
  /** Renames a directory in place (same parent). Fails if the target exists. */
  renameDirectory(from: string, to: string): Promise<Result<void, AppErrorData>>;
  ensureDir(path: string): Promise<void>;
}

export interface ScannedFile {
  readonly path: string;
  readonly relativePath: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
}

export interface LibraryScanner {
  /**
   * Lists media files under `root` (recursive, skipping hidden/temp dirs and
   * symlinks), newest first. Paginated with an opaque cursor; the scan is cached
   * briefly so paging is consistent.
   */
  scan(
    root: string,
    limit: number,
    cursor: string | null
  ): Promise<{
    readonly files: readonly ScannedFile[];
    readonly nextCursor: string | null;
  }>;
  invalidate(): void;
}

export interface JobPaths {
  /**
   * Private per-download directory (0700). Its own entries are the run's plaintext
   * secrets (cookie snapshot, engine config): removed whenever a run ends.
   */
  readonly dir: string;
  /** Engine output log (kept until the download is deleted; compacted when it ends). */
  readonly logFile: string;
  /**
   * Scratch dir for engine temp files (yt-dlp `.part` files and fragments). Kept while
   * the download can run again (pause, app quit, retry) so the next run continues
   * them; removed when the download ends or is deleted.
   */
  readonly tempDir: string;
}

/** What the startup sweep must preserve. */
export interface WorkspaceSweep {
  /** Jobs whose engine may still be running (re-attached or launching): left untouched. */
  readonly inUse: readonly string[];
  /** Downloads that will run again (pending, paused): secrets removed, temp files kept. */
  readonly resumable: readonly string[];
}

export interface JobWorkspace {
  prepare(downloadId: string): Promise<JobPaths>;
  /** Writes a secret file (0600) inside the job dir and returns its path. */
  writePrivateFile(downloadId: string, fileName: string, content: string): Promise<string>;
  /**
   * A run ended but the download will run again (pause, app quit, retry, discarded
   * launch): removes the plaintext secrets of the job and keeps its temp dir, so
   * partial files are continued. The log is kept.
   */
  removeSecrets(downloadId: string): Promise<void>;
  /**
   * The download ended (terminal) or was deleted: removes the whole private dir
   * (secrets and temp files). The log is removed with `removeLog`; otherwise it is
   * compacted to a bounded size. Only call it once no engine can write the log.
   */
  cleanup(downloadId: string, options?: { readonly removeLog?: boolean }): Promise<void>;
  /**
   * Startup hygiene for private job dirs left behind by a crash or a Windows EBUSY,
   * so decrypted secrets never linger: dirs in `inUse` are kept, `resumable` ones
   * lose their secrets but keep their temp files, every other one is removed.
   */
  sweep(keep: WorkspaceSweep): Promise<void>;
  /** Neutral working directory for engine processes (never the download dir). */
  readonly processCwd: string;
}

export interface LogReader {
  /** Bytes consumed so far (persist to resume after a host restart). */
  readonly offset: number;
  /** Complete lines appended since the last call (UTF-8 safe across chunks). */
  readLines(): Promise<string[]>;
  /** Reads until EOF (bounded), returning every remaining complete line + a trailing partial one. */
  drain(): Promise<string[]>;
  close(): Promise<void>;
}

export interface LogReaderFactory {
  open(file: string, offset: number): LogReader;
}

/**
 * Marks a downloaded file as coming from the internet so the OS applies its
 * protections: Windows Mark-of-the-Web (`Zone.Identifier`, ZoneId=3 → SmartScreen,
 * Office Protected View) and macOS quarantine (`com.apple.quarantine` → Gatekeeper).
 * No-op elsewhere. Best effort: failures are logged, never thrown.
 */
export interface DownloadedFileMarker {
  mark(path: string, sourceUrl: string): Promise<void>;
}
