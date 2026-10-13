/**
 * `JobWorkspace`: private per-download scratch space.
 *
 *   <dataDir>/work/<id>/        0700; its own entries are plaintext secrets (cookie snapshot,
 *                               engine config), removed whenever a run ends (`removeSecrets`)
 *   <dataDir>/work/<id>/tmp/    engine temp files (yt-dlp `.part` files, fragments): kept while
 *                               the download can run again, removed with the dir when it ends
 *   <dataDir>/jobs/<id>.log     engine output (compacted when the download ends, removed with it)
 *   <dataDir>/proc-cwd/         neutral cwd for engine processes
 *
 * The startup `sweep` applies the same rules to the dirs a crash left behind.
 */
import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { JobPaths, JobWorkspace, WorkspaceSweep } from '../../application/ports/files.ts';
import type { Logger } from '../../application/ports/system.ts';
import { AppError, ErrorCode } from '../../../shared/kernel/errors.ts';
import { errorCodeOf } from './canonical-path.ts';
import { compactLog, DEFAULT_LOG_COMPACTION, isCompactionTempFile, type LogCompactionLimits } from './log-compactor.ts';

export interface NodeJobWorkspaceOptions {
  readonly dataDir: string;
  readonly logger?: Logger;
  /** Size bounds of the log of a finished download (default `DEFAULT_LOG_COMPACTION`). */
  readonly logCompaction?: LogCompactionLimits;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } as const;
/** The only entry of a job dir that is not a secret (see `prepare`). */
const TEMP_DIR_NAME = 'tmp';

export class NodeJobWorkspace implements JobWorkspace {
  readonly processCwd: string;
  readonly #workRoot: string;
  readonly #jobsDir: string;
  readonly #logger: Logger | null;
  readonly #logCompaction: LogCompactionLimits;

  constructor(options: NodeJobWorkspaceOptions) {
    const dataDir = path.resolve(options.dataDir);
    this.#workRoot = path.join(dataDir, 'work');
    this.#jobsDir = path.join(dataDir, 'jobs');
    this.processCwd = path.join(dataDir, 'proc-cwd');
    this.#logger = options.logger ?? null;
    this.#logCompaction = options.logCompaction ?? DEFAULT_LOG_COMPACTION;
  }

  /** Creates the shared directories (call once at startup; `prepare` also ensures them). */
  async initialize(): Promise<void> {
    await this.#privateDir(this.#workRoot);
    await mkdir(this.#jobsDir, { recursive: true });
    await mkdir(this.processCwd, { recursive: true });
  }

  logFileOf(downloadId: string): string {
    return path.join(this.#jobsDir, `${checkId(downloadId)}.log`);
  }

  async prepare(downloadId: string): Promise<JobPaths> {
    const id = checkId(downloadId);
    await this.initialize();
    const dir = path.join(this.#workRoot, id);
    const tempDir = path.join(dir, TEMP_DIR_NAME);
    await this.#privateDir(dir);
    await this.#privateDir(tempDir);
    return { dir, logFile: this.logFileOf(id), tempDir };
  }

  async writePrivateFile(downloadId: string, fileName: string, content: string): Promise<string> {
    const id = checkId(downloadId);
    if (!FILE_NAME_PATTERN.test(fileName)) throw new AppError(ErrorCode.PATH_INVALID, { reason: 'file-name' });
    const dir = path.join(this.#workRoot, id);
    await this.#privateDir(this.#workRoot);
    await this.#privateDir(dir);
    const target = path.join(dir, fileName);
    const temp = path.join(dir, `.${fileName}.${randomBytes(6).toString('hex')}.tmp`);
    // 'wx' + 0600: never follows/clobbers an existing entry, never world-readable, even briefly.
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return target;
  }

  async removeSecrets(downloadId: string): Promise<void> {
    await this.#removeSecretsIn(path.join(this.#workRoot, checkId(downloadId)));
  }

  async cleanup(downloadId: string, options: { readonly removeLog?: boolean } = {}): Promise<void> {
    const id = checkId(downloadId);
    await this.#remove(path.join(this.#workRoot, id));
    if (options.removeLog) await this.#remove(this.logFileOf(id));
    else await this.#compactLog(this.logFileOf(id));
  }

  async sweep(keep: WorkspaceSweep): Promise<void> {
    await this.#sweepCompactionLeftovers();
    const inUse = new Set(keep.inUse);
    const resumable = new Set(keep.resumable);
    let entries: Dirent[];
    try {
      entries = await readdir(this.#workRoot, { withFileTypes: true });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code !== 'ENOENT') this.#logger?.warn('job workspace sweep failed', { target: this.#workRoot, code });
      return;
    }
    // Only real directories named like a job id: anything else is not ours to delete.
    const jobs = entries.filter(
      (entry) => entry.isDirectory() && ID_PATTERN.test(entry.name) && !inUse.has(entry.name)
    );
    const orphans = jobs.filter((entry) => !resumable.has(entry.name));
    const suspended = jobs.filter((entry) => resumable.has(entry.name));
    await Promise.all([
      ...orphans.map((entry) => this.#remove(path.join(this.#workRoot, entry.name))),
      // Paused/queued downloads continue their partial files; their secrets are re-created by the next launch.
      ...suspended.map((entry) => this.#removeSecretsIn(path.join(this.#workRoot, entry.name)))
    ]);
    if (orphans.length > 0) this.#logger?.info('job workspace swept', { removed: orphans.length });
  }

  /** Temp files of compactions a crash interrupted (the sweep runs before any compaction). */
  async #sweepCompactionLeftovers(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#jobsDir, { withFileTypes: true });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code !== 'ENOENT') this.#logger?.warn('job log sweep failed', { target: this.#jobsDir, code });
      return;
    }
    const leftovers = entries.filter((entry) => entry.isFile() && isCompactionTempFile(entry.name));
    await Promise.all(leftovers.map((entry) => this.#remove(path.join(this.#jobsDir, entry.name))));
  }

  /**
   * Removes every entry of a job dir except its temp dir (a real directory, never a
   * link). A job "dir" that is not a real directory (a link or junction planted in
   * its place) is removed itself — its target is never listed nor touched.
   */
  async #removeSecretsIn(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      if (!(await lstat(dir)).isDirectory()) {
        await this.#remove(dir);
        return;
      }
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === 'ENOENT') return;
      // Secrets cannot be told apart from temp files: remove everything rather than leave them behind.
      this.#logger?.warn('job workspace listing failed', { target: dir, code });
      await this.#remove(dir);
      return;
    }
    const secrets = entries.filter((entry) => !(entry.name === TEMP_DIR_NAME && entry.isDirectory()));
    await Promise.all(secrets.map((entry) => this.#remove(path.join(dir, entry.name))));
  }

  /** Best effort: a log that cannot be compacted is kept as is. */
  async #compactLog(file: string): Promise<void> {
    try {
      const result = await compactLog(file, this.#logCompaction);
      if (result === 'compacted') this.#logger?.info('job log compacted', { target: file });
    } catch (error) {
      this.#logger?.warn('job log compaction failed', { target: file, code: errorCodeOf(error) });
    }
  }

  async #remove(target: string): Promise<void> {
    try {
      await rm(target, RM_OPTIONS);
    } catch (error) {
      // Best effort (e.g. a file still locked on Windows); secrets are also wiped on the next cleanup.
      this.#logger?.warn('job workspace cleanup failed', { target, code: errorCodeOf(error) });
    }
  }

  async #privateDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is filtered by the umask and ignored for existing dirs.
    await chmod(dir, 0o700).catch(() => undefined);
  }
}

function checkId(downloadId: string): string {
  if (!ID_PATTERN.test(downloadId)) throw new AppError(ErrorCode.PATH_INVALID, { reason: 'download-id' });
  return downloadId;
}
