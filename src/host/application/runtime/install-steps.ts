/**
 * The individual steps of an install/update operation:
 * download → verify (SHA-256) → extract → atomic install, and pip installs.
 *
 * Integrity policy: an asset with a pinned SHA-256 must match it (mismatch →
 * `TOOLS_INTEGRITY_FAILED`, file deleted). An asset without one is refused in
 * packaged builds (`TOOLS_NOT_PINNED`) and allowed with a warning in dev builds.
 * The same applies to pip: packaged builds only install a hash lock of the
 * platform (`--require-hashes`); dev builds without one fall back, with a warning,
 * to the pinned requirements (dependencies then resolved by pip, unhashed).
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import type { Logger } from '../ports/system.ts';
import type { ManifestAsset } from './manifest.ts';
import type {
  ArchiveExtractor,
  Downloader,
  DownloadedFile,
  InstalledToolMeta,
  PipInstallRequest,
  PipRunner,
  Staging,
  ToolInstaller
} from './ports.ts';
import { sameDigest } from './checksums.ts';
import { summarizePipLine } from './pip-summary.ts';
import { PHASE_PERCENT, type StepProgress } from './progress.ts';

export interface InstallDeps {
  readonly downloader: Downloader;
  readonly extractor: ArchiveExtractor;
  readonly installer: ToolInstaller;
  readonly pip: PipRunner;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Dev builds only: accept assets whose SHA-256 is not pinned yet (and pip installs without a hash lock). */
  readonly allowUnpinned: boolean;
}

/** What to install for one tool: a manifest asset, possibly re-pointed to a newer verified release. */
export interface InstallTarget {
  readonly tool: ToolId;
  readonly version: string;
  readonly asset: ManifestAsset;
  readonly origin: 'pinned' | 'latest';
}

type StepResult = Result<void, AppErrorData>;

function checkPolicy(deps: InstallDeps, target: InstallTarget): StepResult {
  if (target.asset.sha256 !== null) return ok();
  if (!deps.allowUnpinned) return err({ code: ErrorCode.TOOLS_NOT_PINNED, params: { tool: target.tool } });
  deps.logger.warn('installing an asset without a pinned SHA-256 (dev build)', {
    tool: target.tool,
    url: target.asset.url
  });
  return ok();
}

/** Downloads, verifies and (for archives) extracts into a fresh staging area. */
async function fetchVerified(
  deps: InstallDeps,
  target: InstallTarget,
  step: StepProgress,
  signal: AbortSignal
): Promise<Result<{ readonly staging: Staging; readonly file: DownloadedFile }, AppErrorData>> {
  const policy = checkPolicy(deps, target);
  if (!policy.ok) return policy;
  const { asset, tool } = target;
  const staging = await deps.installer.stage(tool);
  const fail = async (error: AppErrorData): Promise<Result<never, AppErrorData>> => {
    await deps.installer.release(staging);
    return err(error);
  };

  step.phase('download', 'downloading', { name: step.name }, 0);
  const downloaded = await deps.downloader.download({
    tool,
    url: asset.url,
    destination: staging.downloadPath,
    expectedBytes: asset.size ?? null,
    signal,
    onProgress: (received, total) => step.download(received, total)
  });
  if (!downloaded.ok) return fail(downloaded.error);

  step.phase('verify', 'verifying', { name: step.name }, PHASE_PERCENT.verify);
  if (asset.sha256 !== null && !sameDigest(asset.sha256, downloaded.value.sha256)) {
    deps.logger.error('runtime asset failed the integrity check', {
      tool,
      url: asset.url,
      expected: asset.sha256,
      actual: downloaded.value.sha256
    });
    return fail({ code: ErrorCode.TOOLS_INTEGRITY_FAILED, params: { tool } });
  }

  if (asset.archive !== 'none') {
    step.phase('extract', 'extracting', { name: step.name }, PHASE_PERCENT.extract);
    const extracted = await deps.extractor.extract(
      tool,
      staging.downloadPath,
      staging.extractDir,
      asset.archive,
      signal
    );
    if (!extracted.ok) return fail(extracted.error);
  }
  return ok({ staging, file: downloaded.value });
}

function metaFor(deps: InstallDeps, target: InstallTarget, file: DownloadedFile): InstalledToolMeta {
  return {
    tool: target.tool,
    version: target.version,
    sha256: file.sha256,
    source: target.asset.url,
    installedAt: deps.clock.now()
  };
}

/** gallery-dl / yt-dlp / deno / ffmpeg as managed executables. */
export async function installExecutableStep(
  deps: InstallDeps,
  target: InstallTarget,
  step: StepProgress,
  signal: AbortSignal
): Promise<StepResult> {
  if (target.tool === 'python') throw new Error('use installPythonStep for python');
  const fetched = await fetchVerified(deps, target, step, signal);
  if (!fetched.ok) return fetched;
  const { staging, file } = fetched.value;
  try {
    step.phase('install', 'installing', { name: step.name }, PHASE_PERCENT.install);
    const installed = await deps.installer.installExecutable({
      tool: target.tool,
      staging,
      entry: target.asset.archive === 'none' ? null : (target.asset.entry ?? null),
      companions: target.asset.companions ?? {},
      meta: metaFor(deps, target, file)
    });
    if (!installed.ok) return installed;
    step.phase('done', 'installed', { name: step.name, version: target.version }, PHASE_PERCENT.done);
    return ok();
  } finally {
    await deps.installer.release(staging);
  }
}

/**
 * Managed Python (python-build-standalone). `beforeSwap` runs on the staged
 * executable (python mode: pip-installs the engines) before the new distribution
 * replaces the current one; its failure fails the step and nothing is replaced.
 */
export async function installPythonStep(
  deps: InstallDeps,
  target: InstallTarget,
  step: StepProgress,
  signal: AbortSignal,
  beforeSwap: ((stagedExecutable: string) => Promise<StepResult>) | null = null
): Promise<Result<{ readonly executable: string }, AppErrorData>> {
  const entry = target.asset.entry;
  if (!entry) return err({ code: ErrorCode.TOOLS_UNSUPPORTED_PLATFORM, params: { tool: 'python' } });
  const fetched = await fetchVerified(deps, target, step, signal);
  if (!fetched.ok) return fetched;
  const { staging, file } = fetched.value;
  try {
    step.phase('install', 'installing', { name: step.name }, PHASE_PERCENT.install);
    const meta = metaFor(deps, target, file);
    const installed = await deps.installer.installPython({
      staging,
      entry,
      meta,
      ...(beforeSwap ? { beforeSwap } : {})
    });
    if (!installed.ok) return installed;
    step.phase('done', 'installed', { name: step.name, version: target.version }, PHASE_PERCENT.done);
    return installed;
  } finally {
    await deps.installer.release(staging);
  }
}

function checkLockPolicy(deps: InstallDeps, request: PipInstallRequest): StepResult {
  if (request.lock !== null) return ok();
  if (!deps.allowUnpinned) return err({ code: ErrorCode.TOOLS_NOT_PINNED, params: { tool: 'python' } });
  const requirements = request.requirements.join(', ');
  deps.logger.warn('installing python packages without a hash lock (dev build)', { requirements });
  return ok();
}

/**
 * `pip install` of the pinned packages (hash-locked wheels) into a Python (the
 * managed one, or a staged copy). `final: false` when it is part of a Python step,
 * which reports its own completion.
 */
export async function pipInstallStep(
  deps: InstallDeps,
  pythonExecutable: string,
  request: PipInstallRequest,
  step: StepProgress,
  signal: AbortSignal,
  options: { readonly final: boolean } = { final: true }
): Promise<StepResult> {
  const policy = checkLockPolicy(deps, request);
  if (!policy.ok) return policy;
  step.phase('install', 'pipInstalling', { packages: request.requirements.join(', ') }, 0);
  const result = await deps.pip.install(
    pythonExecutable,
    request,
    (line) => {
      const summary = summarizePipLine(line);
      if (summary && summary.code !== 'pipDone') step.phase('install', summary.code, summary.params, summary.percent);
    },
    signal
  );
  if (!result.ok) return result;
  if (options.final) step.phase('done', 'pipDone', {}, PHASE_PERCENT.done);
  return ok();
}
