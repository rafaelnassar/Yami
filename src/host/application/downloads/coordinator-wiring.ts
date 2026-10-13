/**
 * Builds the collaborators of the downloads core from the injected ports.
 * Kept apart from `DownloadCoordinator` so the coordinator only holds the
 * concurrency/lifecycle policy.
 */
import { SlotBudget } from '../../domain/downloads/slot-budget.ts';
import type { LaunchedProcess } from '../ports/processes.ts';
import type { Logger } from '../ports/system.ts';
import { BatchTracker } from './batch-tracker.ts';
import { ControlService } from './control-service.ts';
import { CookieResolver } from './cookie-resolver.ts';
import {
  resolveIds,
  resolveOptions,
  resolveTimers,
  type DownloadCoordinatorDeps,
  type DownloadCoordinatorOptions
} from './coordinator-deps.ts';
import { DownloadRegistry, type ActiveRun } from './download-registry.ts';
import { Finisher } from './finisher.ts';
import { DownloadJournal } from './journal.ts';
import { LaunchService } from './launch-service.ts';
import { LifecycleService } from './lifecycle-service.ts';
import { LineProcessor } from './line-processor.ts';
import { OutputPaths } from './output-paths.ts';
import { ProcessControl } from './process-control.ts';
import { Redactor } from './redactor.ts';
import { RunMonitor } from './run-monitor.ts';
import { Scheduler } from './scheduler.ts';
import { StartService } from './start-service.ts';

export interface DownloadsCore {
  readonly options: DownloadCoordinatorOptions;
  readonly logger: Logger;
  readonly registry: DownloadRegistry;
  readonly journal: DownloadJournal;
  readonly batches: BatchTracker;
  readonly scheduler: Scheduler;
  readonly monitor: RunMonitor;
  readonly control: ControlService;
  readonly starter: StartService;
  readonly lifecycle: LifecycleService;
}

export interface CoreHooks {
  /** A run was launched by this host: watch its exit. */
  readonly onRunStarted: (run: ActiveRun, process: LaunchedProcess) => void;
}

export function wireDownloadsCore(deps: DownloadCoordinatorDeps, hooks: CoreHooks): DownloadsCore {
  const options = resolveOptions(deps.options);
  const { persistence, clock } = deps;
  const logger = deps.logger.child({ module: 'downloads' });
  const registry = new DownloadRegistry();
  const redactor = new Redactor(options.sensitiveDirs);
  const paths = new OutputPaths(options.platform);
  const journal = new DownloadJournal({ persistence, events: deps.events, clock });
  const batches = new BatchTracker(persistence);
  // The scheduler is built on the finisher, which only asks it about launches in flight.
  let scheduler: Scheduler | null = null;
  const lines = new LineProcessor({
    files: persistence.files,
    tx: persistence.tx,
    journal,
    paths,
    clock,
    redactor,
    logger,
    sensitiveDirs: options.sensitiveDirs,
    fileSystem: deps.fileSystem ?? null,
    fileMarker: deps.fileMarker ?? null
  });
  const finisher = new Finisher({
    registry,
    journal,
    lines,
    workspace: deps.workspace,
    cookieVault: deps.cookieVault,
    batches,
    settings: persistence.settings,
    redactor,
    clock,
    logger,
    isLaunching: (downloadId) => scheduler?.isLaunching(downloadId) === true
  });
  const processes = new ProcessControl({ inspector: deps.inspector, terminator: deps.terminator, logger });
  const launcher = new LaunchService({
    engines: deps.engines,
    tools: deps.tools,
    engineEnvironment: deps.engineEnvironment,
    launcher: deps.launcher,
    logReaders: deps.logReaders,
    workspace: deps.workspace,
    cookieVault: deps.cookieVault,
    credentialVault: deps.credentialVault,
    browserCookies: deps.browserCookies,
    sandbox: deps.sandbox,
    settings: persistence.settings,
    cookieResolver: new CookieResolver({ settings: persistence.settings, vault: deps.cookieVault, logger }),
    journal,
    redactor,
    paths,
    logger,
    clock,
    platform: options.platform
  });
  scheduler = new Scheduler({
    registry,
    budget: new SlotBudget(options.maxSlotWeight),
    engines: deps.engines,
    launcher,
    processes,
    finisher,
    journal,
    files: persistence.files,
    clock,
    logger,
    runtimeBusy: deps.runtimeBusy ?? null,
    onRunStarted: hooks.onRunStarted
  });
  const shared = { persistence, registry, batches, journal, finisher, processes, clock, logger };
  return {
    options,
    logger,
    registry,
    journal,
    batches,
    scheduler,
    monitor: new RunMonitor({
      registry,
      lines,
      finisher,
      inspector: deps.inspector,
      journal,
      clock,
      logger,
      staleStrictCheckPolls: options.staleStrictCheckPolls,
      persistEveryMs: options.persistEveryMs,
      livenessEveryMs: options.livenessEveryMs
    }),
    control: new ControlService({ ...shared, workspace: deps.workspace, tools: deps.tools }),
    starter: new StartService({
      persistence,
      registry,
      batches,
      journal,
      tools: deps.tools,
      ids: resolveIds(deps),
      clock,
      logger
    }),
    lifecycle: new LifecycleService({
      ...shared,
      scheduler,
      inspector: deps.inspector,
      logReaders: deps.logReaders,
      engines: deps.engines,
      workspace: deps.workspace,
      redactor,
      paths,
      sandbox: deps.sandbox,
      timers: resolveTimers(deps),
      shutdownDeadlineMs: options.shutdownDeadlineMs
    })
  };
}
