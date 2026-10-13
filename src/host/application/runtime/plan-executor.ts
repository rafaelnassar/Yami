/**
 * Runs the steps of an install/update plan in order, reporting progress per step.
 * A failing step does not stop independent ones (one broken download must not
 * block the others); pip is skipped when Python could not be installed. The
 * first failure becomes the operation error. Cancellation stops immediately.
 *
 * Executables may follow a newer verified upstream release (`latestKnown`); pip
 * never does: python mode installs the manifest pins (hash-locked wheels), so its
 * engines only move when the app ships a new manifest.
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { Engine, RuntimeMode, ToolId } from '../../../shared/domain/engine.ts';
import type { ToolStatus } from '../../../shared/domain/runtime.ts';
import type { PlatformManifest } from './manifest.ts';
import type { PipInstallRequest, ReleasesApi } from './ports.ts';
import type { OperationContext } from './operation-runner.ts';
import {
  installExecutableStep,
  installPythonStep,
  pipInstallStep,
  type InstallDeps,
  type InstallTarget
} from './install-steps.ts';
import { stepTool, type ExecutableTool, type PlanStep } from './install-plan.ts';
import { resolveLatestTarget } from './latest-release.ts';
import { mergeLocks, type LockedWheel } from './python-lock.ts';
import { planTouchesPython, pythonModeRefusal } from './python-mode-policy.ts';
import { isNewer } from './versions.ts';
import type { StepProgress } from './progress.ts';

export interface ExecutorDeps extends InstallDeps {
  readonly releases: ReleasesApi;
  readonly manifest: PlatformManifest;
}

export interface ExecutionInput {
  readonly mode: RuntimeMode;
  readonly statuses: readonly ToolStatus[];
  readonly latestKnown: Readonly<Partial<Record<ToolId, string>>>;
}

type StepResult = Result<void, AppErrorData>;

function unsupported(tool: ToolId): Result<never, AppErrorData> {
  return err({ code: ErrorCode.TOOLS_UNSUPPORTED_PLATFORM, params: { tool } });
}

function pinnedTarget(deps: ExecutorDeps, tool: ToolId): Result<InstallTarget, AppErrorData> {
  const asset = deps.manifest.asset(tool);
  return asset ? ok({ tool, version: asset.version, asset, origin: 'pinned' }) : unsupported(tool);
}

/** The pin, or the newest upstream release when a check found one (verified against its checksum list). */
async function executableTarget(
  deps: ExecutorDeps,
  input: ExecutionInput,
  tool: ExecutableTool,
  signal: AbortSignal
): Promise<Result<InstallTarget, AppErrorData>> {
  const pinned = pinnedTarget(deps, tool);
  if (!pinned.ok) return pinned;
  const feed = deps.manifest.latestFeed(tool);
  const latest = input.latestKnown[tool] ?? null;
  if (!feed || !isNewer(latest, pinned.value.version)) return pinned;

  const resolved = await resolveLatestTarget(deps.releases, feed, tool, pinned.value.asset, signal);
  if (resolved.ok || resolved.error.code === ErrorCode.CANCELLED) return resolved;
  const current = input.statuses.find((s) => s.id === tool);
  if (!current?.installed || isNewer(pinned.value.version, current.version)) {
    deps.logger.warn('latest release unavailable, installing the pinned version', { tool, error: resolved.error });
    return pinned;
  }
  return resolved;
}

/** The manifest pins of `engines` and their merged hash lock (`null` unless every engine has one). */
function pipRequest(deps: ExecutorDeps, engines: readonly Engine[]): Result<PipInstallRequest, AppErrorData> {
  const requirements = engines.map((engine) => {
    const pin = deps.manifest.pythonPackage(engine);
    return `${pin.requirement}==${pin.version}`;
  });
  const locks: (readonly LockedWheel[])[] = [];
  for (const engine of engines) {
    const lock = deps.manifest.pythonLock(engine);
    if (lock === null) return ok({ requirements, lock: null });
    locks.push(lock);
  }
  const merged = mergeLocks(locks);
  if (merged.ok) return ok({ requirements, lock: merged.value });
  // Unreachable with a validated manifest (conflicting locks are rejected at load).
  const detail = `conflicting locks for ${merged.error.name}: ${merged.error.versions.join(', ')}`;
  return err({ code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail } });
}

export async function executePlan(
  deps: ExecutorDeps,
  plan: readonly PlanStep[],
  input: ExecutionInput,
  context: OperationContext
): Promise<StepResult> {
  const { progress, signal } = context;
  // Before any step: a refused pip step must not leave a freshly replaced managed Python behind.
  if (input.mode === 'python' && planTouchesPython(plan)) {
    const refusal = pythonModeRefusal(deps.manifest, !deps.allowUnpinned);
    if (refusal) return err(refusal);
  }
  progress.setTotalSteps(plan.length);
  const pythonStatus = input.statuses.find((s) => s.id === 'python');
  let pythonExecutable = pythonStatus?.installed ? pythonStatus.path : null;
  const failures: AppErrorData[] = [];

  const runStep = async (step: PlanStep, reporter: StepProgress): Promise<StepResult> => {
    switch (step.kind) {
      case 'python': {
        const target = pinnedTarget(deps, 'python');
        if (!target.ok) return target;
        // Python mode: the engines go into the staged distribution first (same lock policy and
        // `--require-hashes` path as a pip step); if that fails nothing is swapped and the step fails.
        const packages = step.packages.length > 0 ? pipRequest(deps, step.packages) : null;
        if (packages && !packages.ok) return packages;
        const beforeSwap = packages
          ? (staged: string) => pipInstallStep(deps, staged, packages.value, reporter, signal, { final: false })
          : null;
        const installed = await installPythonStep(deps, target.value, reporter, signal, beforeSwap);
        // On failure the current distribution (if any) is untouched and stays usable.
        if (!installed.ok) return installed;
        pythonExecutable = installed.value.executable;
        return ok();
      }
      case 'pip': {
        if (!pythonExecutable) {
          return err({
            code: ErrorCode.TOOLS_INSTALL_FAILED,
            params: { tool: 'python', detail: 'python unavailable' }
          });
        }
        const request = pipRequest(deps, step.engines);
        return request.ok ? pipInstallStep(deps, pythonExecutable, request.value, reporter, signal) : request;
      }
      case 'executable': {
        const target = await executableTarget(deps, input, step.tool, signal);
        return target.ok ? installExecutableStep(deps, target.value, reporter, signal) : target;
      }
    }
  };

  for (const [index, step] of plan.entries()) {
    if (signal.aborted) return err({ code: ErrorCode.CANCELLED });
    const reporter = progress.step(index, stepTool(step));
    reporter.phase('start', 'preparing', { name: reporter.name }, 0);
    let result: StepResult;
    try {
      result = await runStep(step, reporter);
    } catch (error) {
      result = err({
        code: ErrorCode.TOOLS_INSTALL_FAILED,
        params: { tool: reporter.tool, detail: String(error).slice(0, 300) }
      });
    }
    if (result.ok) continue;
    if (result.error.code === ErrorCode.CANCELLED || signal.aborted) return err({ code: ErrorCode.CANCELLED });
    deps.logger.warn('runtime step failed', { tool: reporter.tool, error: result.error });
    reporter.phase('error', 'toolFailed', { name: reporter.name, error: result.error.code });
    failures.push(result.error);
  }
  const first = failures[0];
  return first ? err(first) : ok();
}
