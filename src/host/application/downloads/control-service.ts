/**
 * Per-download commands (pause, resume, stop, restart, forget) and their
 * "all" variants (run in parallel: each stop may wait on the OS). Kills are
 * identity-checked; when a kill fails the command returns PROCESS_KILL_FAILED and
 * the download state is left unchanged. Forgotten ids answer CONVERSATION_NOT_FOUND
 * to every command and are never adopted again.
 */
import { appError, ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { isActiveStatus } from '../../../shared/domain/download.ts';
import { Download } from '../../domain/downloads/download.ts';
import type { JobWorkspace } from '../ports/files.ts';
import type { PersistenceContext } from '../ports/persistence.ts';
import type { ToolRegistry } from '../ports/runtime.ts';
import type { Logger } from '../ports/system.ts';
import type { BatchTracker } from './batch-tracker.ts';
import type { DownloadRegistry } from './download-registry.ts';
import type { CommandOutcome } from './downloads-facade.ts';
import type { Finisher } from './finisher.ts';
import type { DownloadJournal } from './journal.ts';
import type { ProcessControl } from './process-control.ts';
import { fromRecord } from './record-mapper.ts';

export interface ControlServiceDeps {
  readonly persistence: PersistenceContext;
  readonly registry: DownloadRegistry;
  readonly batches: BatchTracker;
  readonly journal: DownloadJournal;
  readonly finisher: Finisher;
  readonly processes: ProcessControl;
  readonly workspace: JobWorkspace;
  readonly tools: ToolRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Result of stopping the engine of a download before a pause/stop:
 * `halted` (nothing ran or it was killed), `finished` (it had already exited and
 * the run completed on its own), `requeued` (it had exited and a cookie retry put
 * it back in the queue — the command still applies), `failed` (kill failed).
 */
type Halt = 'halted' | 'finished' | 'requeued' | 'failed';

const NOT_FOUND: AppErrorData = appError(ErrorCode.CONVERSATION_NOT_FOUND);

export class ControlService {
  readonly #deps: ControlServiceDeps;

  constructor(deps: ControlServiceDeps) {
    this.#deps = deps;
  }

  async pause(id: string): Promise<CommandOutcome> {
    const found = this.#activeDownload(id, ErrorCode.DOWNLOAD_NOT_ACTIVE);
    if (!found.ok) return found;
    const download = found.value;
    const halt = await this.#halt(download);
    if (halt === 'failed') return err(appError(ErrorCode.PROCESS_KILL_FAILED));
    if (halt === 'finished') return ok({ conversationId: id });
    const paused = download.pause(this.#deps.clock.now());
    if (!paused.ok) return paused;
    this.#commitUpdated(download);
    return ok({ conversationId: id });
  }

  resume(id: string): CommandOutcome {
    const found = this.#activeDownload(id, ErrorCode.DOWNLOAD_NOT_PAUSED);
    if (!found.ok) return found;
    const resumed = found.value.resume(this.#deps.clock.now());
    if (!resumed.ok) return resumed;
    this.#commitUpdated(found.value);
    return ok({ conversationId: id });
  }

  async stop(id: string): Promise<CommandOutcome> {
    const found = this.#activeDownload(id, ErrorCode.DOWNLOAD_NOT_ACTIVE);
    if (!found.ok) return found;
    const download = found.value;
    const halt = await this.#halt(download);
    if (halt === 'failed') return err(appError(ErrorCode.PROCESS_KILL_FAILED));
    if (halt === 'finished') return ok({ conversationId: id });
    const cancelled = download.cancel(this.#deps.clock.now());
    if (!cancelled.ok) return cancelled;
    await this.#deps.finisher.completeTerminal(download, 'updated');
    return ok({ conversationId: id });
  }

  restart(id: string): CommandOutcome {
    const { registry, persistence, tools, batches, clock } = this.#deps;
    if (registry.isForgotten(id)) return err(NOT_FOUND);
    if (registry.get(id)) return err(appError(ErrorCode.DOWNLOAD_STILL_ACTIVE));
    const record = persistence.downloads.get(id);
    if (!record) return err(NOT_FOUND);
    if (isActiveStatus(record.status)) return err(appError(ErrorCode.DOWNLOAD_STILL_ACTIVE));
    if (!tools.resolveEngine(record.engine))
      return err(appError(ErrorCode.ENGINE_UNAVAILABLE, { engine: record.engine }));
    const download = Download.restore(fromRecord(record));
    // A restarted download goes to the end of the queue.
    const restarted = download.restart(clock.now(), persistence.downloads.nextPosition());
    if (!restarted.ok) return restarted;
    registry.add(download);
    this.#commitUpdated(download);
    batches.track(download.batchId);
    return ok({ conversationId: id });
  }

  /**
   * Stops (if needed) and forgets a download: supervision, job workspace and log.
   * Rows are deleted by the caller. The id is tombstoned for this host's life.
   */
  async forget(id: string): Promise<Result<void, AppErrorData>> {
    const { registry, batches, workspace, clock, logger, journal } = this.#deps;
    if (registry.isForgotten(id)) return err(NOT_FOUND);
    const download = registry.get(id);
    if (download) {
      const run = registry.runOf(id);
      if (download.status === 'running') {
        const stopped = await this.#deps.processes.stop(download.process, run);
        if (stopped === 'failed') return err(appError(ErrorCode.PROCESS_KILL_FAILED));
      }
      await run?.reader.close().catch(() => undefined);
      batches.removeMember(download.batchId, id);
      const summary = batches.settle(download.batchId, clock.now(), new Set([id]));
      if (summary) journal.defer({ type: 'batch.finished', batch: summary });
    }
    registry.forget(id);
    await workspace
      .cleanup(id, { removeLog: true })
      .catch((error: unknown) => logger.warn('job workspace cleanup failed', { downloadId: id, error: String(error) }));
    return ok();
  }

  async pauseAll(): Promise<number> {
    return this.#forEach(['running', 'pending'], (id) => this.pause(id), 'pausedAll');
  }

  async resumeAll(): Promise<number> {
    return this.#forEach(['paused'], async (id) => this.resume(id), 'resumedAll');
  }

  async stopAll(): Promise<number> {
    return this.#forEach(['running', 'pending', 'paused'], (id) => this.stop(id), 'stoppedAll');
  }

  /** Runs `command` for every matching download in parallel (independent downloads). */
  async #forEach(
    statuses: readonly Download['status'][],
    command: (id: string) => Promise<CommandOutcome>,
    logCode: string
  ): Promise<number> {
    const ids = this.#deps.registry.withStatus(...statuses).map((download) => download.id);
    const results = await Promise.allSettled(ids.map((id) => command(id)));
    let affected = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value.ok) affected += 1;
      else if (result.status === 'rejected') {
        this.#deps.logger.error('bulk command failed', { downloadId: ids[index], error: String(result.reason) });
      }
    }
    if (affected > 0) this.#deps.journal.logCode('info', logCode, { count: affected });
    return affected;
  }

  /** Stops the engine of a running download (no-op for pending/paused). */
  async #halt(download: Download): Promise<Halt> {
    if (download.status !== 'running') return 'halted';
    const { registry, processes, finisher } = this.#deps;
    const run = registry.runOf(download.id);
    const stopped = await processes.stop(download.process, run);
    if (stopped === 'failed') return 'failed';
    if (stopped === 'exited') return (await finisher.finishRun(download, run)) === 'requeued' ? 'requeued' : 'finished';
    await finisher.drainAndRelease(download, run);
    return 'halted';
  }

  /**
   * The in-memory download, adopting an active row that is not in memory yet
   * (command before `initialize`, or a row left active by an older host).
   */
  #activeDownload(id: string, inactiveCode: ErrorCode): Result<Download, AppErrorData> {
    const { registry, persistence, batches } = this.#deps;
    if (registry.isForgotten(id)) return err(NOT_FOUND);
    const known = registry.get(id);
    if (known) return ok(known);
    const record = persistence.downloads.get(id);
    if (!record) return err(NOT_FOUND);
    if (!isActiveStatus(record.status)) return err(appError(inactiveCode));
    const adopted = Download.restore(fromRecord(record));
    registry.add(adopted);
    batches.track(adopted.batchId);
    return ok(adopted);
  }

  #commitUpdated(download: Download): void {
    if (!this.#deps.journal.commit(download)) {
      this.#deps.registry.remove(download.id);
      this.#deps.logger.warn('download row vanished; dropping it', { downloadId: download.id });
      return;
    }
    this.#deps.journal.changed(download.id, 'updated');
  }
}
