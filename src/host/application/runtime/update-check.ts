/**
 * "Check for updates": asks the upstream feed of each floating tool (yt-dlp) for
 * its newest release. Other tools follow the pins of the app release, so they need
 * no network check (fewer unauthenticated GitHub API calls).
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import type { PlatformManifest } from './manifest.ts';
import type { ReleasesApi } from './ports.ts';
import type { OperationContext } from './operation-runner.ts';
import { latestVersion } from './latest-release.ts';
import { PHASE_PERCENT } from './progress.ts';

export async function checkForUpdates(
  releases: ReleasesApi,
  manifest: PlatformManifest,
  tools: readonly ToolId[],
  context: OperationContext
): Promise<Result<Partial<Record<ToolId, string>>, AppErrorData>> {
  const { progress, signal } = context;
  progress.setTotalSteps(tools.length);
  const found: Partial<Record<ToolId, string>> = {};
  for (const [index, tool] of tools.entries()) {
    const feed = manifest.latestFeed(tool);
    if (!feed) continue;
    if (signal.aborted) return err({ code: ErrorCode.CANCELLED });
    const step = progress.step(index, tool);
    step.phase('start', 'checking', { name: step.name }, 0);
    const latest = await latestVersion(releases, feed, tool, signal);
    // A failed check keeps the previous results and does not bump `checkedAt`
    // (legacy reported "all up to date" after a failed check).
    if (!latest.ok) return latest;
    found[tool] = latest.value;
    step.phase('done', 'checked', { name: step.name, version: latest.value }, PHASE_PERCENT.done);
  }
  return ok(found);
}
