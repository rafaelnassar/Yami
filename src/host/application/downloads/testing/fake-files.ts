/**
 * Fake filesystem ports: job workspace, path sandbox, file stats and the
 * downloaded-file marker.
 */
import type { AppErrorData } from '../../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../../shared/kernel/result.ts';
import type {
  DownloadedFileMarker,
  FileStat,
  FileSystemPort,
  JobPaths,
  JobWorkspace,
  PathSandbox,
  WorkspaceSweep
} from '../../ports/files.ts';

export const WORK_ROOT = '/data/work';
export const JOBS_ROOT = '/data/jobs';
export const DOWNLOAD_DIR = '/dl';

export class FakeJobWorkspace implements JobWorkspace {
  readonly processCwd = '/data/proc-cwd';
  readonly prepared: string[] = [];
  readonly privateFiles = new Map<string, string>();
  /** Terminal cleanups (whole job dir; log compacted, or removed with `removeLog`). */
  readonly cleanups: { readonly id: string; readonly removeLog: boolean }[] = [];
  /** Ids whose secrets were removed with the temp dir kept (the run ended, the download did not). */
  readonly secretRemovals: string[] = [];
  readonly sweeps: WorkspaceSweep[] = [];
  failPrepare = false;
  /** While set, `prepare` waits for it (simulates slow launch work). */
  gate: Promise<void> | null = null;

  static pathsOf(downloadId: string): JobPaths {
    return {
      dir: `${WORK_ROOT}/${downloadId}`,
      logFile: `${JOBS_ROOT}/${downloadId}.log`,
      tempDir: `${WORK_ROOT}/${downloadId}/tmp`
    };
  }

  async prepare(downloadId: string): Promise<JobPaths> {
    if (this.gate) await this.gate;
    if (this.failPrepare) throw new Error(`EACCES: cannot create ${WORK_ROOT}/${downloadId}`);
    this.prepared.push(downloadId);
    return FakeJobWorkspace.pathsOf(downloadId);
  }

  async writePrivateFile(downloadId: string, fileName: string, content: string): Promise<string> {
    const path = `${WORK_ROOT}/${downloadId}/${fileName}`;
    this.privateFiles.set(path, content);
    return path;
  }

  async removeSecrets(downloadId: string): Promise<void> {
    this.secretRemovals.push(downloadId);
  }

  async cleanup(downloadId: string, options?: { readonly removeLog?: boolean }): Promise<void> {
    this.cleanups.push({ id: downloadId, removeLog: options?.removeLog === true });
  }

  async sweep(keep: WorkspaceSweep): Promise<void> {
    this.sweeps.push({ inUse: [...keep.inUse], resumable: [...keep.resumable] });
  }
}

export class FakePathSandbox implements PathSandbox {
  downloadDir = DOWNLOAD_DIR;

  async resolveInside(input: string): Promise<Result<string, AppErrorData>> {
    return ok(input);
  }

  async validateDownloadDir(input: string): Promise<Result<string, AppErrorData>> {
    return ok(input);
  }

  setDownloadDir(canonicalDir: string): void {
    this.downloadDir = canonicalDir;
  }
}

export class FakeFileSystem implements FileSystemPort {
  readonly sizes = new Map<string, number>();
  readonly statCalls: string[] = [];

  async stat(path: string): Promise<FileStat | null> {
    this.statCalls.push(path);
    const size = this.sizes.get(path);
    return size === undefined ? null : { sizeBytes: size, modifiedAt: 0, isDirectory: false };
  }

  async removeFile(): Promise<Result<void, AppErrorData>> {
    return ok();
  }

  async renameDirectory(): Promise<Result<void, AppErrorData>> {
    return ok();
  }

  async ensureDir(): Promise<void> {}
}

export class FakeFileMarker implements DownloadedFileMarker {
  readonly marked: { readonly path: string; readonly sourceUrl: string }[] = [];
  fail = false;

  async mark(path: string, sourceUrl: string): Promise<void> {
    if (this.fail) throw new Error('xattr failed');
    this.marked.push({ path, sourceUrl });
  }
}

/** A promise with its resolver exposed (manual gates in tests). */
export function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
