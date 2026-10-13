/**
 * Host lifecycle of the downloads core.
 *
 * - `initialize`: loads active downloads (never forgotten ones); a `running` one
 *   whose process is still alive (strict identity) is re-attached — its log is
 *   tailed from the persisted offset — otherwise it is finalized from its log. A
 *   download that cannot be supervised again is stopped and paused, never left
 *   "running" without supervision. Leftover private job dirs are then swept
 *   (secrets of every job not in use; temp files only of downloads that will not
 *   run again).
 * - `shutdown('pause')`: launches in flight are discarded (the download stays
 *   queued); running engines are stopped IN PARALLEL and put back in the queue at
 *   their position, so the next launch resumes them in the original order (user
 *   paused downloads stay paused) and continues their partial files (the job's
 *   temp dir is kept, only its secrets are removed). Everything is bounded by one
 *   deadline: an engine not confirmed stopped by then stays committed as running,
 *   and the next host re-attaches to it.
 * - `shutdown('detach')`: engines keep running; offsets are persisted for re-attach.
 */
import type { Clock } from '../../../shared/kernel/clock.ts';
import { Download } from '../../domain/downloads/download.ts';
import type { EngineRegistry, LineParser } from '../ports/engines.ts';
import type { JobWorkspace, LogReader, LogReaderFactory, PathSandbox } from '../ports/files.ts';
import type { PersistenceContext } from '../ports/persistence.ts';
import type { ProcessInspector } from '../ports/processes.ts';
import type { Logger } from '../ports/system.ts';
import type { BatchTracker } from './batch-tracker.ts';
import { Deadline } from './deadline.ts';
import type { ActiveRun, DownloadRegistry } from './download-registry.ts';
import type { ShutdownMode } from './downloads-facade.ts';
import type { Finisher } from './finisher.ts';
import type { DownloadJournal } from './journal.ts';
import type { OutputPaths } from './output-paths.ts';
import type { ProcessControl } from './process-control.ts';
import { fromRecord } from './record-mapper.ts';
import type { Redactor } from './redactor.ts';
import type { Scheduler } from './scheduler.ts';
import type { TimerPort } from './timers.ts';

export interface LifecycleServiceDeps {
  readonly persistence: PersistenceContext;
  readonly registry: DownloadRegistry;
  readonly batches: BatchTracker;
  readonly journal: DownloadJournal;
  readonly finisher: Finisher;
  readonly processes: ProcessControl;
  readonly scheduler: Scheduler;
  readonly inspector: ProcessInspector;
  readonly logReaders: LogReaderFactory;
  readonly engines: EngineRegistry;
  readonly workspace: JobWorkspace;
  readonly redactor: Redactor;
  readonly paths: OutputPaths;
  readonly sandbox: PathSandbox;
  readonly timers: TimerPort;
  readonly shutdownDeadlineMs: number;
  readonly clock: Clock;
  readonly logger: Logger;
}

function emptyReader(offset: number): LogReader {
  return { offset, readLines: async () => [], drain: async () => [], close: async () => undefined };
}

export class LifecycleService {
  readonly #deps: LifecycleServiceDeps;

  constructor(deps: LifecycleServiceDeps) {
    this.#deps = deps;
  }

  async initialize(): Promise<void> {
    const { persistence, registry, batches } = this.#deps;
    for (const record of persistence.downloads.listActive()) {
      if (registry.get(record.id) || registry.isForgotten(record.id)) continue;
      registry.add(Download.restore(fromRecord(record)));
      batches.track(record.batchId);
    }
    for (const download of registry.withStatus('running')) {
      if (registry.runOf(download.id)) continue;
      try {
        await this.#reattachOrFinish(download);
      } catch (error) {
        this.#deps.logger.error('re-attach failed', { downloadId: download.id, error: String(error) });
        await this.#recoverUnsupervised(download);
      }
    }
    await this.#sweepWorkspaces();
  }

  async shutdown(mode: ShutdownMode): Promise<void> {
    const deadline = new Deadline(this.#deps.timers, this.#deps.shutdownDeadlineMs);
    try {
      await this.#settleLaunches(mode, deadline);
      const running = this.#deps.registry.withStatus('running');
      // Latest counters/offsets first: whatever happens next, the rows allow a re-attach.
      for (const download of running) this.#persist(download);
      if (mode === 'detach' || deadline.expired) {
        for (const download of running) await this.#detach(download);
        return;
      }
      const stops = Promise.allSettled(running.map((download) => this.#stopForExit(download, deadline)));
      if (!(await deadline.race(stops))) {
        this.#deps.logger.warn('shutdown deadline reached; engines not confirmed stopped are left for re-attach');
      }
    } finally {
      deadline.cancel();
    }
  }

  /* ───────────── Shutdown ───────────── */

  /** Waits (bounded) for launches in flight and settles them before the runs are handled. */
  async #settleLaunches(mode: ShutdownMode, deadline: Deadline): Promise<void> {
    const { scheduler, logger } = this.#deps;
    const attempts = scheduler.pendingAttempts();
    if (attempts.length === 0) return;
    const settled = await deadline.race(Promise.allSettled(attempts));
    // Still launching: their spawn is persisted as running, so the next host re-attaches.
    if (!settled) return;
    const commits = settled.value.flatMap((outcome) =>
      outcome.status === 'fulfilled'
        ? [
            scheduler
              .commit(outcome.value, { discard: mode === 'pause' })
              .catch((error: unknown) => logger.error('shutdown: settling a launch failed', { error: String(error) }))
          ]
        : []
    );
    await deadline.race(Promise.allSettled(commits));
  }

  async #stopForExit(download: Download, deadline: Deadline): Promise<void> {
    const { registry, processes, finisher, journal, clock, logger } = this.#deps;
    const run = registry.runOf(download.id);
    try {
      const stopped = await processes.stop(download.process, run);
      // Too late: the row stays "running" (committed above) and the next host re-attaches.
      if (deadline.expired) return;
      if (stopped === 'failed') {
        logger.warn('shutdown: engine could not be terminated; left for re-attach', { downloadId: download.id });
        await this.#detach(download);
        return;
      }
      if (stopped === 'exited') {
        await finisher.finishRun(download, run);
        return;
      }
      await finisher.drainAndRelease(download, run);
      download.requeueOnExit(clock.now());
      if (journal.commit(download)) journal.changed(download.id, 'updated');
    } catch (error) {
      logger.error('shutdown of download failed', { downloadId: download.id, error: String(error) });
    }
  }

  #persist(download: Download): void {
    try {
      this.#deps.journal.commit(download);
    } catch (error) {
      this.#deps.logger.error('shutdown: persisting a running download failed', {
        downloadId: download.id,
        error: String(error)
      });
    }
  }

  /** Leaves the engine running: its row (committed) is re-attached by the next host. */
  async #detach(download: Download): Promise<void> {
    const run = this.#deps.registry.runOf(download.id);
    this.#deps.registry.deleteRun(download.id);
    await run?.reader.close().catch(() => undefined);
  }

  /* ───────────── Start-up ───────────── */

  async #reattachOrFinish(download: Download): Promise<void> {
    const { registry, finisher, journal, persistence, redactor } = this.#deps;
    const alive = download.process ? await this.#isAlive(download) : false;
    const run = this.#openRun(download);
    download.attachRun(download.counters.done > 0 ? persistence.files.pathsByConversation(download.id) : []);
    if (!alive) {
      await finisher.finishRun(download, run);
      return;
    }
    registry.setRun(run);
    journal.logCode('info', 'reattached', { url: redactor.text(download.sourceUrl) }, download.id);
  }

  /**
   * Re-attach failed: never leave the download "running" without supervision.
   * Its engine is stopped and the download paused (resumable); when the engine
   * cannot be stopped it is supervised by liveness only (no log).
   */
  async #recoverUnsupervised(download: Download): Promise<void> {
    const { registry, processes, journal, clock, logger } = this.#deps;
    if (registry.get(download.id) !== download || download.status !== 'running' || registry.runOf(download.id)) return;
    try {
      const stopped = await processes.stop(download.process, undefined);
      if (stopped === 'failed') {
        registry.setRun(this.#livenessOnlyRun(download));
        return;
      }
      download.pause(clock.now(), 'recovery');
      if (journal.commit(download)) journal.changed(download.id, 'updated');
      else registry.remove(download.id);
    } catch (error) {
      logger.error('recovery of an unsupervised download failed', { downloadId: download.id, error: String(error) });
    }
  }

  async #isAlive(download: Download): Promise<boolean> {
    const identity = download.process;
    if (!identity) return false;
    try {
      return await this.#deps.inspector.isAlive(identity, { strict: true });
    } catch (error) {
      // Unknown: keep supervising rather than finalizing a download that may still run.
      this.#deps.logger.warn('re-attach inspection failed', { downloadId: download.id, error: String(error) });
      return true;
    }
  }

  #openRun(download: Download): ActiveRun {
    const { engines, logReaders, paths, sandbox } = this.#deps;
    const outputDir = paths.engineDir(sandbox.downloadDir, download.engine);
    const reader = download.logFile
      ? logReaders.open(download.logFile, download.logOffset)
      : emptyReader(download.logOffset);
    const parser = engines.get(download.engine).createParser({ downloadDir: outputDir });
    return this.#run(download, reader, parser, outputDir);
  }

  /** Last resort: no log, no parser — only process liveness ends the run. */
  #livenessOnlyRun(download: Download): ActiveRun {
    const noise: LineParser = { parse: () => ({ kind: 'noise' }) };
    return this.#run(download, emptyReader(download.logOffset), noise, this.#deps.sandbox.downloadDir);
  }

  #run(download: Download, reader: LogReader, parser: LineParser, outputDir: string): ActiveRun {
    return {
      downloadId: download.id,
      reader,
      parser,
      launchedHere: false,
      downloadDir: this.#deps.sandbox.downloadDir,
      outputDir,
      tempDir: null,
      cookie: null,
      exit: null,
      stalePolls: 0,
      lastPersistAt: this.#deps.clock.now(),
      persistedOffset: download.logOffset
    };
  }

  /**
   * Removes private job dirs left by a crash (decrypted cookies), keeping those still
   * in use; downloads that will run again (pending, paused) keep their temp files.
   */
  async #sweepWorkspaces(): Promise<void> {
    const { registry, scheduler, workspace, logger } = this.#deps;
    const inUse = [...registry.runs().map((run) => run.downloadId), ...scheduler.launchingIds()];
    const busy = new Set(inUse);
    // The registry only holds active downloads (terminal ones were retired).
    const resumable = registry.all().flatMap((download) => (busy.has(download.id) ? [] : [download.id]));
    try {
      await workspace.sweep({ inUse, resumable });
    } catch (error) {
      logger.warn('job workspace sweep failed', { error: String(error) });
    }
  }
}
