/**
 * Ports of the runtime-tools context (implemented by `host/infrastructure/runtime`).
 *
 * They are deliberately small so `RuntimeToolsService` can be tested with fakes:
 * the application decides *what* to install and enforces the integrity policy;
 * adapters only move bytes, run processes and touch the filesystem.
 */
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import type { RuntimeMode, ToolId, ToolSource } from '../../../shared/domain/engine.ts';
import type { ArchiveKind } from './manifest.ts';
import type { LockedWheel } from './python-lock.ts';

/* ─────────────────────────── Download ─────────────────────────── */

export interface DownloadRequest {
  /** Tool the bytes belong to (used in error params). */
  readonly tool: ToolId;
  /** HTTPS URL; redirects must stay on HTTPS. */
  readonly url: string;
  readonly destination: string;
  /** Exact size when known (from the manifest / release API); mismatch fails. */
  readonly expectedBytes: number | null;
  readonly signal: AbortSignal;
  /** Throttled by the adapter. `total` is `null` when the server sent no length. */
  readonly onProgress?: (received: number, total: number | null) => void;
}

export interface DownloadedFile {
  readonly bytes: number;
  /** Lower-case hex SHA-256 computed while streaming (no second read). */
  readonly sha256: string;
}

export interface Downloader {
  download(request: DownloadRequest): Promise<Result<DownloadedFile, AppErrorData>>;
}

/* ─────────────────────────── Releases API ─────────────────────────── */

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number | null;
}

export interface ReleaseInfo {
  readonly repo: string;
  readonly tag: string;
  readonly assets: readonly ReleaseAsset[];
}

export interface ReleasesApi {
  /** Latest published release of `owner/repo` (GitHub). */
  latest(repo: string, signal: AbortSignal): Promise<Result<ReleaseInfo, AppErrorData>>;
  /** Small text document (checksum lists). HTTPS only, bounded by `maxBytes`. */
  fetchText(url: string, maxBytes: number, signal: AbortSignal): Promise<Result<string, AppErrorData>>;
}

/* ─────────────────────────── Archives ─────────────────────────── */

export interface ArchiveExtractor {
  /**
   * Extracts into `destinationDir` (created when missing). Rejects entries that
   * would land outside of it (absolute, `..`, escaping symlinks).
   */
  extract(
    tool: ToolId,
    archivePath: string,
    destinationDir: string,
    kind: Exclude<ArchiveKind, 'none'>,
    signal: AbortSignal
  ): Promise<Result<void, AppErrorData>>;
}

/* ─────────────────────────── Filesystem layout / install ─────────────────────────── */

/** Scratch area for one install step (inside the runtime dir, same filesystem). */
export interface Staging {
  readonly downloadPath: string;
  readonly extractDir: string;
}

/** Written next to every managed tool (`bin/.<tool>.json`). */
export interface InstalledToolMeta {
  readonly tool: ToolId;
  readonly version: string;
  readonly sha256: string | null;
  readonly source: string;
  readonly installedAt: number;
}

export interface InstallExecutableRequest {
  readonly tool: Exclude<ToolId, 'python'>;
  readonly staging: Staging;
  /** `null` → the downloaded file itself is the executable. */
  readonly entry: string | null;
  /** Extra binaries shipped in the same archive (e.g. `ffprobe`), name → entry. */
  readonly companions: Readonly<Record<string, string>>;
  readonly meta: InstalledToolMeta;
}

export interface InstallPythonRequest {
  readonly staging: Staging;
  /** Python executable inside the extracted archive; its first segment is the distribution root. */
  readonly entry: string;
  readonly meta: InstalledToolMeta;
  /**
   * Runs with the staged (extracted, not yet installed) Python executable before it
   * replaces the current distribution — python mode pip-installs the engines there.
   * A failure aborts the install: the current distribution stays untouched.
   */
  readonly beforeSwap?: (stagedExecutable: string) => Promise<Result<void, AppErrorData>>;
}

export interface ToolInstaller {
  /** Creates the layout and removes leftovers of interrupted runs. */
  prepare(): Promise<void>;
  stage(tool: ToolId): Promise<Staging>;
  /** Deletes the staging files (always called, success or not). */
  release(staging: Staging): Promise<void>;
  /** Atomically replaces `bin/<tool>` (+ companions) and records the metadata. */
  installExecutable(request: InstallExecutableRequest): Promise<Result<{ readonly path: string }, AppErrorData>>;
  /** Atomically replaces the managed Python distribution. */
  installPython(request: InstallPythonRequest): Promise<Result<{ readonly executable: string }, AppErrorData>>;
  readMeta(tool: ToolId): Promise<InstalledToolMeta | null>;
}

/* ─────────────────────────── pip ─────────────────────────── */

export interface PipInstallRequest {
  /** Manifest-pinned top-level requirements (`name[extras]==version`). */
  readonly requirements: readonly string[];
  /**
   * Every wheel to install, hash-pinned: installed with `--require-hashes --no-deps`
   * from a private lockfile instead of `requirements`. `null` only in dev builds
   * whose manifest has no lock yet (pip then resolves the dependencies itself).
   */
  readonly lock: readonly LockedWheel[] | null;
}

export interface PipRunner {
  /**
   * `python -I -m pip install --isolated --only-binary=:all: …` (wheels only) of the
   * locked wheels, or of the pinned requirements when there is no lock. Every output
   * line (stdout + stderr) is passed to `onLine`.
   */
  install(
    pythonExecutable: string,
    request: PipInstallRequest,
    onLine: (line: string) => void,
    signal: AbortSignal
  ): Promise<Result<void, AppErrorData>>;
}

/* ─────────────────────────── Detection ─────────────────────────── */

export interface ProbedTool {
  readonly path: string;
  /** Directory of `path` (for PATH entries of engine processes). */
  readonly directory: string;
  readonly source: ToolSource;
  /** Raw first line of the version output, `null` when the probe failed. */
  readonly rawVersion: string | null;
  /** Arguments that precede engine arguments (python mode: `['-I', '-X', 'utf8', '-m', 'yt_dlp']`). */
  readonly prefixArgs: readonly string[];
}

export interface ProbeSnapshot {
  readonly tools: Readonly<Record<ToolId, ProbedTool | null>>;
  /** Managed `bin/` directory. */
  readonly managedBinDir: string;
}

export interface ToolProbe {
  /** Locates every tool for `mode` and probes versions in parallel (bounded timeouts). */
  probe(mode: RuntimeMode): Promise<ProbeSnapshot>;
}
