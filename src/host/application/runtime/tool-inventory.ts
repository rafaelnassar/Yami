/**
 * What is installed right now: the last probe snapshot plus the metadata of the
 * managed tools, and everything derived from them (statuses, engine resolution,
 * PATH entries of engine processes). Probing itself is scheduled by the service.
 */
import { TOOL_IDS, type Engine, type RuntimeMode, type ToolId } from '../../../shared/domain/engine.ts';
import type { ToolStatus } from '../../../shared/domain/runtime.ts';
import type { ResolvedExecutable } from '../ports/engines.ts';
import type { PlatformManifest } from './manifest.ts';
import type { InstalledToolMeta, ProbeSnapshot, ToolInstaller, ToolProbe } from './ports.ts';
import type { RuntimePrefsStore } from './runtime-prefs.ts';
import { buildToolStatuses } from './tool-status.ts';

type Metas = Partial<Record<ToolId, InstalledToolMeta>>;

export interface ToolInventoryDeps {
  readonly manifest: PlatformManifest;
  readonly probe: ToolProbe;
  readonly installer: ToolInstaller;
  readonly prefs: RuntimePrefsStore;
}

export class ToolInventory {
  readonly #deps: ToolInventoryDeps;
  #snapshot: ProbeSnapshot | null = null;
  #metas: Metas = {};

  constructor(deps: ToolInventoryDeps) {
    this.#deps = deps;
  }

  /** `false` until the first probe completed (nothing is known to be missing yet). */
  get probed(): boolean {
    return this.#snapshot !== null;
  }

  /** Probes for the current mode and replaces the snapshot; rejects (keeping the old one) when the probe fails. */
  async reload(): Promise<void> {
    const [snapshot, metas] = await this.#read(this.#deps.prefs.get().runtimeMode);
    this.#snapshot = snapshot;
    this.#metas = metas;
  }

  /** Freshly probed statuses for `mode`, without replacing the snapshot (operations plan from these). */
  async fresh(mode: RuntimeMode): Promise<ToolStatus[]> {
    const [snapshot, metas] = await this.#read(mode);
    return buildToolStatuses({ mode, snapshot, metas, manifest: this.#deps.manifest, latestKnown: this.latestKnown() });
  }

  statuses(): ToolStatus[] {
    return buildToolStatuses({
      mode: this.#deps.prefs.get().runtimeMode,
      snapshot: this.#snapshot,
      metas: this.#metas,
      manifest: this.#deps.manifest,
      latestKnown: this.latestKnown()
    });
  }

  /** Newest upstream versions found by the last update check. */
  latestKnown(): Readonly<Partial<Record<ToolId, string>>> {
    return this.#deps.prefs.get().toolUpdates.latest;
  }

  resolveEngine(engine: Engine): ResolvedExecutable | null {
    const probed = this.#snapshot?.tools[engine];
    return probed ? { path: probed.path, prefixArgs: probed.prefixArgs } : null;
  }

  resolveHelper(tool: 'ffmpeg' | 'deno'): string | null {
    return this.#snapshot?.tools[tool]?.path ?? null;
  }

  pathEntries(): readonly string[] {
    const snapshot = this.#snapshot;
    if (!snapshot) return [];
    const managed = this.#deps.prefs.get().runtimeMode === 'standalone' ? snapshot.managedBinDir : null;
    const dirs = [managed, snapshot.tools.ffmpeg?.directory, snapshot.tools.deno?.directory];
    return [...new Set(dirs.filter((d): d is string => typeof d === 'string' && d.length > 0))];
  }

  #read(mode: RuntimeMode): Promise<[ProbeSnapshot, Metas]> {
    return Promise.all([this.#deps.probe.probe(mode), this.#readMetas()]);
  }

  async #readMetas(): Promise<Metas> {
    const entries = await Promise.all(
      TOOL_IDS.map(async (tool) => [tool, await this.#deps.installer.readMeta(tool)] as const)
    );
    const metas: Metas = {};
    for (const [tool, meta] of entries) if (meta) metas[tool] = meta;
    return metas;
  }
}
