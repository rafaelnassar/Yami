/**
 * Pure projection of probe results + manifest + persisted "latest" versions into
 * domain `ToolStatus` values, plus the derived rules (required tools, update targets).
 */
import {
  ENGINES,
  TOOL_IDS,
  type Engine,
  type RuntimeMode,
  type ToolId,
  type ToolSource
} from '../../../shared/domain/engine.ts';
import type { EngineInfo, ToolStatus } from '../../../shared/domain/runtime.ts';
import type { PlatformManifest } from './manifest.ts';
import type { InstalledToolMeta, ProbeSnapshot, ProbedTool } from './ports.ts';
import { extractVersionToken, isNewer, newestOf } from './versions.ts';

export interface StatusInputs {
  readonly mode: RuntimeMode;
  readonly snapshot: ProbeSnapshot | null;
  readonly metas: Readonly<Partial<Record<ToolId, InstalledToolMeta>>>;
  readonly manifest: PlatformManifest;
  /** Newest upstream versions found by the last update check (tools with a latest feed only). */
  readonly latestKnown: Readonly<Partial<Record<ToolId, string>>>;
}

const STANDALONE_REQUIRED: readonly ToolId[] = ['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg'];
const PYTHON_REQUIRED: readonly ToolId[] = ['python', 'gallery-dl', 'yt-dlp', 'deno', 'ffmpeg'];

/** Tools the mode needs before downloads can run (Python is only required in python mode). */
export function requiredTools(mode: RuntimeMode): readonly ToolId[] {
  return mode === 'python' ? PYTHON_REQUIRED : STANDALONE_REQUIRED;
}

export function isEngineTool(tool: ToolId): tool is Engine {
  return (ENGINES as readonly string[]).includes(tool);
}

/** Version the app pins for `tool` in `mode` (pip pin for engines in python mode). */
export function pinnedVersion(manifest: PlatformManifest, mode: RuntimeMode, tool: ToolId): string | null {
  if (mode === 'python' && isEngineTool(tool)) return manifest.pythonPackage(tool).version;
  return manifest.asset(tool)?.version ?? null;
}

/**
 * Newest version the app is allowed to install: the pin, or a newer verified
 * upstream release. Python-mode engines are pip packages installed from the
 * manifest's hash lock, so their target is always the pin: an update is offered
 * only when an app update ships a newer manifest.
 */
export function targetVersion(
  manifest: PlatformManifest,
  mode: RuntimeMode,
  tool: ToolId,
  latestKnown: Readonly<Partial<Record<ToolId, string>>>
): string | null {
  const pinned = pinnedVersion(manifest, mode, tool);
  if (!pinned) return null;
  if (mode === 'python' && isEngineTool(tool)) return pinned;
  const latest = manifest.latestFeed(tool) ? (latestKnown[tool] ?? null) : null;
  return newestOf(pinned, latest);
}

/** Comparable installed version: the recorded manifest version for managed installs, else the probe token. */
export function installedVersion(probed: ProbedTool | null, meta: InstalledToolMeta | undefined): string | null {
  if (!probed) return null;
  if (probed.source === 'managed' && meta) return meta.version;
  return extractVersionToken(probed.rawVersion);
}

/**
 * Which installs are offered updates: managed copies always; an outdated system
 * engine too (a managed copy then takes precedence — stale yt-dlp builds break
 * sites); system Python/Deno/ffmpeg and dev overrides are left alone.
 */
function updatable(tool: ToolId, mode: RuntimeMode, source: ToolSource): boolean {
  if (source === 'env' || source === 'none') return false;
  if (mode === 'python' && isEngineTool(tool)) return source === 'python';
  if (isEngineTool(tool)) return true;
  return source === 'managed';
}

export function buildToolStatuses(inputs: StatusInputs): ToolStatus[] {
  const { mode, snapshot, metas, manifest, latestKnown } = inputs;
  return TOOL_IDS.map((tool): ToolStatus => {
    const probed = snapshot?.tools[tool] ?? null;
    const version = installedVersion(probed, metas[tool]);
    const source: ToolSource = probed?.source ?? 'none';
    const latest = targetVersion(manifest, mode, tool, latestKnown);
    return {
      id: tool,
      installed: probed !== null,
      version,
      source,
      path: probed?.path ?? null,
      pinnedVersion: pinnedVersion(manifest, mode, tool),
      latestVersion: latest,
      updateAvailable: probed !== null && updatable(tool, mode, source) && isNewer(latest, version)
    };
  });
}

export function missingTools(statuses: readonly ToolStatus[], mode: RuntimeMode): ToolId[] {
  const required = new Set(requiredTools(mode));
  return statuses.filter((s) => required.has(s.id) && !s.installed).map((s) => s.id);
}

export function engineInfos(statuses: readonly ToolStatus[]): Record<Engine, EngineInfo> {
  const info = (engine: Engine): EngineInfo => {
    const status = statuses.find((s) => s.id === engine);
    return {
      engine,
      available: status?.installed ?? false,
      version: status?.version ?? null,
      source: status?.source ?? 'none'
    };
  };
  return { 'gallery-dl': info('gallery-dl'), 'yt-dlp': info('yt-dlp') };
}
