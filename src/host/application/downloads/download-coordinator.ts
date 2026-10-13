/**
 * `DownloadCoordinator` — the downloads core behind `DownloadsFacade`.
 *
 * Every mutation (commands, scheduling, launch commits, supervision passes) runs
 * through one FIFO `Mutex`, so state changes never interleave; `snapshot()` reads
 * memory synchronously. Slow launch work (workspace, cookies, spawn) runs outside
 * the mutex (see `Scheduler`). Scheduling and supervision run as background tasks:
 * commands return as soon as their own transition is committed.
 *
 * Completion events (`download.finished`, `batch.finished`, notices) are published
 * right after the change listeners were notified, so the state they trigger is
 * never older than the completion.
 */
import { appError, ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { Mutex } from '../../../shared/kernel/async.ts';
import { err, type Result } from '../../../shared/kernel/result.ts';
import type { LaunchedProcess } from '../ports/processes.ts';
import type { Logger } from '../ports/system.ts';
import { BackgroundTasks } from './background-tasks.ts';
import type { BatchTracker } from './batch-tracker.ts';
import type { ControlService } from './control-service.ts';
import { resolveTimers, type DownloadCoordinatorDeps } from './coordinator-deps.ts';
import { wireDownloadsCore } from './coordinator-wiring.ts';
import type { ActiveRun, DownloadRegistry } from './download-registry.ts';
import type {
  CommandOutcome,
  DownloadsFacade,
  DownloadsSnapshot,
  ShutdownMode,
  StartDownloadsInput,
  StartDownloadsOutput
} from './downloads-facade.ts';
import type { DownloadJournal } from './journal.ts';
import type { LifecycleService } from './lifecycle-service.ts';
import type { RunMonitor } from './run-monitor.ts';
import type { Reservation, Scheduler } from './scheduler.ts';
import { buildSnapshot } from './snapshot-builder.ts';
import type { StartService } from './start-service.ts';
import { Supervisor, type TickOutcome } from './supervisor.ts';

const SHUTTING_DOWN: AppErrorData = appError(ErrorCode.HOST_SHUTTING_DOWN);

export class DownloadCoordinator implements DownloadsFacade {
  readonly #mutex = new Mutex();
  readonly #listeners = new Set<() => void>();
  readonly #background: BackgroundTasks;
  readonly #registry: DownloadRegistry;
  readonly #journal: DownloadJournal;
  readonly #logger: Logger;
  readonly #batches: BatchTracker;
  readonly #scheduler: Scheduler;
  readonly #monitor: RunMonitor;
  readonly #supervisor: Supervisor;
  readonly #control: ControlService;
  readonly #starter: StartService;
  readonly #lifecycle: LifecycleService;
  #initialized = false;
  #shutdownMode: ShutdownMode | null = null;
  #scheduleQueued = false;

  constructor(deps: DownloadCoordinatorDeps) {
    const core = wireDownloadsCore(deps, { onRunStarted: (run, process) => this.#watchExit(run, process) });
    this.#background = deps.background ?? new BackgroundTasks();
    this.#registry = core.registry;
    this.#journal = core.journal;
    this.#logger = core.logger;
    this.#batches = core.batches;
    this.#scheduler = core.scheduler;
    this.#monitor = core.monitor;
    this.#control = core.control;
    this.#starter = core.starter;
    this.#lifecycle = core.lifecycle;
    this.#supervisor = new Supervisor(
      resolveTimers(deps),
      { minMs: core.options.pollMinMs, maxMs: core.options.pollMaxMs },
      () => this.#tick()
    );
  }

  /* ───────────── DownloadsFacade ───────────── */

  async initialize(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      if (this.#initialized || this.#shuttingDown) return;
      this.#initialized = true;
      await this.#lifecycle.initialize();
      this.#afterMutation();
    });
  }

  start(input: StartDownloadsInput): Promise<Result<StartDownloadsOutput, AppErrorData>> {
    return this.#command(() => this.#starter.start(input));
  }

  pause(conversationId: string): Promise<CommandOutcome> {
    return this.#command(() => this.#control.pause(conversationId));
  }

  resume(conversationId: string): Promise<CommandOutcome> {
    return this.#command(() => this.#control.resume(conversationId));
  }

  stop(conversationId: string): Promise<CommandOutcome> {
    return this.#command(() => this.#control.stop(conversationId));
  }

  restart(conversationId: string): Promise<CommandOutcome> {
    return this.#command(() => this.#control.restart(conversationId));
  }

  pauseAll(): Promise<{ readonly affected: number }> {
    return this.#bulk(() => this.#control.pauseAll());
  }

  resumeAll(): Promise<{ readonly affected: number }> {
    return this.#bulk(() => this.#control.resumeAll());
  }

  stopAll(): Promise<{ readonly affected: number }> {
    return this.#bulk(() => this.#control.stopAll());
  }

  forget(conversationId: string): Promise<Result<void, AppErrorData>> {
    return this.#command(() => this.#control.forget(conversationId));
  }

  snapshot(): DownloadsSnapshot {
    return buildSnapshot(this.#registry, this.#batches);
  }

  /**
   * True while work is in progress (running or pending). Paused downloads do not
   * count: pausing is how the user frees the engines (e.g. to update the tools).
   */
  hasActive(): boolean {
    return this.#registry.withStatus('running', 'pending').length > 0;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async shutdown(mode: ShutdownMode): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      if (this.#shuttingDown) return;
      this.#shutdownMode = mode;
      this.#supervisor.stop();
      await this.#lifecycle.shutdown(mode);
      this.#notify();
    });
  }

  /* ───────────── Composition root ───────────── */

  /**
   * Plans launches again. The composition root calls it from `runtime.onChange`,
   * so downloads held back while tools were installing (`runtimeBusy`) start.
   */
  reschedule(): void {
    this.#requestSchedule();
  }

  /* ───────────── Internals ───────────── */

  get #shuttingDown(): boolean {
    return this.#shutdownMode !== null;
  }

  #command<T>(
    task: () => Promise<Result<T, AppErrorData>> | Result<T, AppErrorData>
  ): Promise<Result<T, AppErrorData>> {
    return this.#mutex.runExclusive(async () => {
      if (this.#shuttingDown) return err(SHUTTING_DOWN);
      const result = await task();
      this.#afterMutation();
      return result;
    });
  }

  #bulk(task: () => Promise<number>): Promise<{ readonly affected: number }> {
    return this.#mutex.runExclusive(async () => {
      if (this.#shuttingDown) return { affected: 0 };
      const affected = await task();
      this.#afterMutation();
      return { affected };
    });
  }

  #afterMutation(): void {
    this.#requestSchedule();
    this.#syncSupervision();
    this.#notify();
  }

  #requestSchedule(): void {
    if (this.#scheduleQueued || this.#shuttingDown) return;
    this.#scheduleQueued = true;
    this.#inBackground(async () => {
      this.#scheduleQueued = false;
      if (this.#shuttingDown) return;
      for (const reservation of this.#scheduler.reserve()) this.#launch(reservation);
    });
  }

  /** The launch runs outside the mutex; its outcome is committed under it. */
  #launch(reservation: Reservation): void {
    const committed = this.#scheduler.launch(reservation).then((attempt) =>
      this.#mutex.runExclusive(async () => {
        const changed = await this.#scheduler.commit(attempt, { discard: this.#shutdownMode === 'pause' });
        if (!this.#shuttingDown) {
          // A failed or discarded launch freed its slot.
          this.#requestSchedule();
          this.#syncSupervision();
        }
        if (changed || this.#journal.hasDeferred) this.#notify();
      })
    );
    this.#background.track(
      committed.catch((error: unknown) =>
        this.#logger.error('launch commit failed', { downloadId: reservation.target.id, error: String(error) })
      )
    );
  }

  #syncSupervision(): void {
    if (this.#registry.runs().length > 0) this.#supervisor.ensureRunning();
  }

  async #tick(): Promise<TickOutcome> {
    const work = this.#mutex.runExclusive(async (): Promise<TickOutcome> => {
      if (this.#shuttingDown) return { activity: 'idle', active: false };
      const activity = await this.#monitor.tick();
      if (activity === 'structural') this.#requestSchedule();
      if (activity !== 'idle' || this.#journal.hasDeferred) this.#notify();
      return { activity, active: this.#registry.runs().length > 0 };
    });
    this.#background.track(
      work.then(
        () => undefined,
        () => undefined
      )
    );
    try {
      return await work;
    } catch (error) {
      this.#logger.error('supervision pass failed', { error: String(error) });
      return { activity: 'idle', active: this.#registry.runs().length > 0 };
    }
  }

  #watchExit(run: ActiveRun, process: LaunchedProcess): void {
    const onExit = (exit: { readonly code: number | null; readonly signal: string | null }): void => {
      // Ignore exits of runs that were already released (paused, stopped, forgotten).
      if (this.#registry.runOf(run.downloadId) !== run) return;
      run.exit = exit;
      this.#supervisor.wake();
    };
    process.exited.then(onExit, (error: unknown) => {
      this.#logger.warn('process exit watch failed', { downloadId: run.downloadId, error: String(error) });
      onExit({ code: null, signal: null });
    });
  }

  #inBackground(task: () => Promise<void>): void {
    const promise = this.#mutex
      .runExclusive(task)
      .catch((error: unknown) => this.#logger.error('background task failed', { error: String(error) }));
    this.#background.track(promise);
  }

  /** Notifies snapshot listeners, then publishes the completion events of the same pass. */
  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.warn('downloads change listener failed', { error: String(error) });
      }
    }
    this.#journal.flushDeferred();
  }
}
