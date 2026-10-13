/**
 * "Latest" support for tools with an upstream feed (yt-dlp): look up the newest
 * release and turn it into an install target verified against the release's own
 * checksum list (`SHA2-256SUMS`). Without a matching checksum nothing is installed.
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import { assetFileName, type ManifestAsset } from './manifest.ts';
import type { ReleasesApi } from './ports.ts';
import { checksumFor } from './checksums.ts';
import type { InstallTarget } from './install-steps.ts';
import { normalizeTag } from './versions.ts';

export interface LatestFeed {
  readonly repo: string;
  readonly checksumsAsset: string;
}

const MAX_CHECKSUMS_BYTES = 256 * 1024;

/** Error params name the tool (the API adapter only knows the repo / URL). */
function forTool(error: AppErrorData, tool: ToolId): AppErrorData {
  return error.code === ErrorCode.CANCELLED ? error : { code: error.code, params: { ...error.params, tool } };
}

export async function latestVersion(
  releases: ReleasesApi,
  feed: LatestFeed,
  tool: ToolId,
  signal: AbortSignal
): Promise<Result<string, AppErrorData>> {
  const release = await releases.latest(feed.repo, signal);
  if (!release.ok) return err(forTool(release.error, tool));
  const version = normalizeTag(release.value.tag);
  return version ? ok(version) : err({ code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool, detail: 'empty tag' } });
}

export async function resolveLatestTarget(
  releases: ReleasesApi,
  feed: LatestFeed,
  tool: ToolId,
  pinned: ManifestAsset,
  signal: AbortSignal
): Promise<Result<InstallTarget, AppErrorData>> {
  const release = await releases.latest(feed.repo, signal);
  if (!release.ok) return err(forTool(release.error, tool));
  const fileName = assetFileName(pinned.url);
  const asset = release.value.assets.find((a) => a.name === fileName);
  if (!asset) {
    return err({
      code: ErrorCode.TOOLS_INSTALL_FAILED,
      params: { tool, detail: `release asset not found: ${fileName}` }
    });
  }
  const sums = release.value.assets.find((a) => a.name === feed.checksumsAsset);
  if (!sums) return err({ code: ErrorCode.TOOLS_INTEGRITY_FAILED, params: { tool } });
  const text = await releases.fetchText(sums.url, MAX_CHECKSUMS_BYTES, signal);
  if (!text.ok) return err(forTool(text.error, tool));
  const sha256 = checksumFor(text.value, fileName);
  if (!sha256) return err({ code: ErrorCode.TOOLS_INTEGRITY_FAILED, params: { tool } });
  const version = normalizeTag(release.value.tag);
  return ok({
    tool,
    version,
    origin: 'latest',
    asset: { ...pinned, version, url: asset.url, sha256, size: asset.size }
  });
}
