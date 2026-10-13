/**
 * Runtime-tools application service: detection snapshot, install/update/check
 * operations (background, single-flight) and the `ToolRegistry` used by downloads.
 * Never blocks the host: probes and operations are async; commands return at once.
 *
 * Collaborators: `ToolInventory` (what is installed), `operation-works.ts` (what
 * each operation does), `OperationRunner` (single-flight execution + progress).
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { systemClock, type Clock } from '../../../shared/kernel/clock.ts';
import { newId } from '../../../shared/kernel/ids.ts';
import { TOOL_IDS, type Engine, type RuntimeMode, type ToolId } from '../../../shared/domain/engine.ts';
import type { RuntimeOperationKind, RuntimeStatusDto } from '../../../shared/contracts/dto.ts';
import type { EngineInfo } from '../../../shared/domain/runtime.ts';
import type { ResolvedExecutable } from '../ports/engines.ts';
import type { HostSettingsRepository } from '../ports/persistence.ts';
import type { RuntimeService } from '../ports/runtime.ts';
import type { EventSink, Logger } from '../ports/system.ts';
import type { PlatformManifest } from './manifest.ts';
import type { ArchiveExtractor, Downloader, PipRunner, ReleasesApi, ToolInstaller, ToolProbe } from './ports.ts';
import { OperationRunner, type AfterWork, type OperationWork } from './operation-runner.ts';
import {
  checkUpdatesWork,
  installAfterWork,
  installWork,
  updateWork,
  type OperationWorkDeps
} from './operation-works.ts';
import { pythonModeRefusal, touchesPythonMode } from './python-mode-policy.ts';
import { assembleEngineInfos, assembleRuntimeStatus } from './runtime-status.ts';
import { missingTools, requiredTools } from './tool-status.ts';
import { ToolInventory } from './tool-inventory.ts';
import { autoInstallFailedNotice, UpdateNotifier } from './update-notices.ts';
import { CoalescingTask, RuntimePrefsStore } from './runtime-prefs.ts';

export interface RuntimeServiceDeps {
  readonly manifest: PlatformManifest;
  readonly isPackaged: boolean;
  readonly probe: ToolProbe;
  readonly downloader: Downloader;
  readonly extractor: ArchiveExtractor;
  readonly installer: ToolInstaller;
  readonly pip: PipRunner;
  readonly releases: ReleasesApi;
  readonly settings: HostSettingsRepository;
  readonly events: EventSink;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly newId?: () => string;
}

type OperationResult = Result<{ readonly operationId: string }, AppErrorData>;

export class RuntimeToolsService implements RuntimeService {
  readonly #deps: RuntimeServiceDeps;
  readonly #clock: Clock;
  readonly #works: OperationWorkDeps;
  readonly #runner: OperationRunner;
  readonly #notifier: UpdateNotifier;
  readonly #listeners = new Set<() => void>();
  readonly #prefs: RuntimePrefsStore;
  readonly #inventory: ToolInventory;
  readonly #refresher: CoalescingTask;
  #downloadsActive: () => boolean = () => false;
  #prepared: Promise<void> | null = null;
  #autoInstallRequested = false;
  #disposed = false;

  constructor(deps: RuntimeServiceDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    const logger = deps.logger.child({ module: 'runtime' });
    this.#notifier = new UpdateNotifier(deps.events, this.#clock);
    this.#prefs = new RuntimePrefsStore(deps.settings);
    this.#inventory = new ToolInventory({
      manifest: deps.manifest,
      probe: deps.probe,
      installer: deps.installer,
      prefs: this.#prefs
    });
    this.#refresher = new CoalescingTask(() => this.#probeNow());
    this.#works = {
      executor: { ...deps, logger, clock: this.#clock, allowUnpinned: !deps.isPackaged },
      inventory: this.#inventory,
      prefs: this.#prefs,
      clock: this.#clock,
      refresh: () => this.refresh()
    };
    this.#runner = new OperationRunner({
      events: deps.events,
      clock: this.#clock,
      logger,
      newId: deps.newId ?? (() => newId('rt-')),
      onChange: () => this.#changed()
    });
  }

  status(): RuntimeStatusDto {
    const prefs = this.#prefs.get();
    return assembleRuntimeStatus({
      mode: prefs.runtimeMode,
      setupDismissed: prefs.setupDismissed,
      busy: this.#runner.isBusy(),
      operation: this.#runner.current,
      updatesCheckedAt: prefs.toolUpdates.checkedAt,
      tools: this.#inventory.statuses(),
      probed: this.#inventory.probed,
      manifest: this.#deps.manifest
    });
  }

  engines(): Readonly<Record<Engine, EngineInfo>> {
    return assembleEngineInfos(this.#inventory.statuses());
  }

  resolveEngine(engine: Engine): ResolvedExecutable | null {
    return this.#inventory.resolveEngine(engine);
  }

  resolveHelper(tool: 'ffmpeg' | 'deno'): string | null {
    return this.#inventory.resolveHelper(tool);
  }

  pathEntries(): readonly string[] {
    return this.#inventory.pathEntries();
  }

  isBusy(): boolean {
    return this.#runner.isBusy();
  }

  /** Not part of the port yet: lets the session layer broadcast `state` when the runtime status changes. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh(): Promise<void> {
    return this.#refresher.run();
  }

  async setMode(mode: RuntimeMode): Promise<void> {
    if (this.#prefs.get().runtimeMode !== mode) {
      this.#prefs.update({ runtimeMode: mode, setupDismissed: true });
      this.#changed();
    }
    await this.refresh();
  }

  dismissSetup(): void {
    this.#prefs.update({ setupDismissed: true });
    this.#changed();
  }

  setDownloadsActiveProbe(probe: () => boolean): void {
    this.#downloadsActive = probe;
  }

  startInstall(mode: RuntimeMode): OperationResult {
    return this.#startInstall(mode, null);
  }

  startUpdate(tools: readonly ToolId[] | null): OperationResult {
    const guard = this.#guard(true);
    if (!guard.ok) return guard;
    const requested = tools ? TOOL_IDS.filter((t) => tools.includes(t)) : null;
    const listed =
      requested ??
      this.#inventory
        .statuses()
        .filter((s) => s.updateAvailable)
        .map((s) => s.id);
    // Like an install: never replace the managed Python for pip packages this build may not install.
    if (this.#prefs.get().runtimeMode === 'python' && touchesPythonMode(listed)) {
      const refusal = pythonModeRefusal(this.#deps.manifest, this.#deps.isPackaged);
      if (refusal) return err(refusal);
    }
    return this.#start('update', listed, updateWork(this.#works, requested), () => this.refresh());
  }

  startCheckUpdates(): OperationResult {
    const guard = this.#guard(false);
    if (!guard.ok) return guard;
    const feeds = TOOL_IDS.filter((t) => this.#deps.manifest.latestFeed(t) !== null);
    return this.#start('check-updates', feeds, checkUpdatesWork(this.#works, feeds), async () => {});
  }

  autoInstallMissing(): void {
    if (this.#autoInstallRequested || this.#disposed) return;
    this.#autoInstallRequested = true;
    void this.#autoInstall().catch((error: unknown) => {
      this.#deps.logger.error('runtime auto-install crashed', { error: String(error) });
    });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#listeners.clear();
    await this.#runner.dispose();
  }

  #startInstall(mode: RuntimeMode, onFailure: ((error: AppErrorData) => void) | null): OperationResult {
    const guard = this.#guard(true);
    if (!guard.ok) return guard;
    // Refused up front (before Python is downloaded): packaged builds only pip-install hash-locked wheels.
    const refusal = mode === 'python' ? pythonModeRefusal(this.#deps.manifest, this.#deps.isPackaged) : null;
    if (refusal) return err(refusal);
    const current = this.#inventory.probed ? missingTools(this.#inventory.statuses(), mode) : [...requiredTools(mode)];
    return this.#start(
      'install',
      current,
      installWork(this.#works, mode),
      installAfterWork(this.#works, mode, onFailure)
    );
  }

  async #autoInstall(): Promise<void> {
    await this.refresh();
    const prefs = this.#prefs.get();
    const missing = missingTools(this.#inventory.statuses(), prefs.runtimeMode);
    if (this.#disposed || prefs.setupDismissed || missing.length === 0) return;
    this.#deps.logger.info('auto-installing missing runtime tools', { tools: missing });
    const notify = (error: AppErrorData): void => {
      const stillMissing = missingTools(this.#inventory.statuses(), this.#prefs.get().runtimeMode);
      this.#deps.events.publish({
        type: 'notice',
        notice: autoInstallFailedNotice(stillMissing, error.code, this.#clock.now())
      });
    };
    const started = this.#startInstall(prefs.runtimeMode, notify);
    if (!started.ok) {
      this.#deps.logger.warn('runtime auto-install not started', { error: started.error });
      if (started.error.code !== ErrorCode.TOOLS_BUSY && started.error.code !== ErrorCode.TOOLS_DOWNLOADS_ACTIVE)
        notify(started.error);
    }
  }

  #guard(mutates: boolean): Result<void, AppErrorData> {
    if (this.#disposed) return err({ code: ErrorCode.HOST_SHUTTING_DOWN });
    if (this.#runner.isBusy()) return err({ code: ErrorCode.TOOLS_BUSY });
    if (!mutates) return ok();
    if (this.#downloadsActive()) return err({ code: ErrorCode.TOOLS_DOWNLOADS_ACTIVE });
    if (this.#deps.isPackaged && !this.#deps.manifest.fullyPinned) return err({ code: ErrorCode.TOOLS_NOT_PINNED });
    return ok();
  }

  #start(
    kind: RuntimeOperationKind,
    tools: readonly ToolId[],
    work: OperationWork,
    afterWork: AfterWork
  ): OperationResult {
    const wrapped: OperationWork = async (context) => {
      await this.#ensurePrepared();
      return work(context);
    };
    return ok({
      operationId: this.#runner.start(kind, tools, kind === 'check-updates' ? 'checkUpdates' : kind, wrapped, afterWork)
    });
  }

  #ensurePrepared(): Promise<void> {
    // Cleans `.tmp` leftovers once, before the first probe/operation of this host process.
    this.#prepared ??= this.#deps.installer.prepare().catch((error: unknown) => {
      this.#deps.logger.warn('runtime layout preparation failed', { error: String(error) });
    });
    return this.#prepared;
  }

  async #probeNow(): Promise<void> {
    if (this.#disposed) return; // no process spawning during shutdown
    await this.#ensurePrepared();
    try {
      await this.#inventory.reload();
    } catch (error) {
      this.#deps.logger.error('runtime probe failed', { error: String(error) });
      return;
    }
    this.#notifier.evaluate(this.#inventory.statuses());
    this.#changed();
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#deps.logger.error('runtime change listener failed', { error: String(error) });
      }
    }
  }
}
