/**
 * One supervision pass over running downloads: tail logs, apply lines, detect
 * process exit and finish runs, persist counters/offsets (throttled).
 *
 * Exit detection:
 * - runs launched by this host get their exit through `LaunchedProcess.exited`;
 * - re-attached runs are polled with the cheap batched `aliveMany` at most every
 *   `livenessEveryMs` (it runs while the downloads mutex is held), and, after
 *   `staleStrictCheckPolls` passes without log growth, with a strict identity
 *   check (guards against PID reuse) — the only strict OS read of a pass.
 */
import type { Clock } from '../../../shared/kernel/clock.ts';
import type { Download } from '../../domain/downloads/download.ts';
import type { ProcessInspector } from '../ports/processes.ts';
import type { Logger } from '../ports/system.ts';
import type { ActiveRun, DownloadRegistry } from './download-registry.ts';
import type { Finisher } from './finisher.ts';
import type { DownloadJournal } from './journal.ts';
import type { LineProcessor } from './line-processor.ts';

export type TickActivity = 'structural' | 'progress' | 'idle';

export interface RunMonitorDeps {
  readonly registry: DownloadRegistry;
  readonly lines: LineProcessor;
  readonly finisher: Finisher;
  readonly inspector: ProcessInspector;
  readonly journal: DownloadJournal;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly staleStrictCheckPolls: number;
  readonly persistEveryMs: number;
  readonly livenessEveryMs: number;
}

const NO_LIVENESS: ReadonlyMap<number, boolean> = new Map();

export class RunMonitor {
  readonly #deps: RunMonitorDeps;
  #livenessAt = Number.NEGATIVE_INFINITY;

  constructor(deps: RunMonitorDeps) {
    this.#deps = deps;
  }

  async tick(): Promise<TickActivity> {
    const runs = this.#deps.registry.runs();
    const alive = await this.#aliveMap(runs);
    let structural = false;
    let progress = false;
    for (const run of runs) {
      const download = this.#deps.registry.get(run.downloadId);
      if (!download || download.status !== 'running') continue;
      try {
        const result = await this.#supervise(download, run, alive);
        structural ||= result === 'structural';
        progress ||= result === 'progress';
      } catch (error) {
        this.#deps.logger.error('supervision failed', { downloadId: run.downloadId, error: String(error) });
      }
    }
    return structural ? 'structural' : progress ? 'progress' : 'idle';
  }

  async #supervise(download: Download, run: ActiveRun, alive: ReadonlyMap<number, boolean>): Promise<TickActivity> {
    const before = download.logOffset;
    const lines = await run.reader.readLines();
    const changed = await this.#deps.lines.process(download, run, lines);

    if (run.exit || (await this.#isGone(download, run, before, alive))) {
      await this.#deps.finisher.finishRun(download, run);
      return 'structural';
    }
    this.#persistThrottled(download, run);
    return changed ? 'progress' : 'idle';
  }

  async #isGone(
    download: Download,
    run: ActiveRun,
    offsetBefore: number,
    alive: ReadonlyMap<number, boolean>
  ): Promise<boolean> {
    if (run.launchedHere) return false;
    const identity = download.process;
    if (!identity) return true;
    if (alive.get(identity.pid) === false) return true;
    run.stalePolls = download.logOffset === offsetBefore ? run.stalePolls + 1 : 0;
    if (run.stalePolls < this.#deps.staleStrictCheckPolls) return false;
    run.stalePolls = 0;
    try {
      return !(await this.#deps.inspector.isAlive(identity, { strict: true }));
    } catch (error) {
      this.#deps.logger.warn('strict process check failed', { pid: identity.pid, error: String(error) });
      return false;
    }
  }

  /** Liveness of re-attached runs, refreshed at most every `livenessEveryMs` (empty map = unknown). */
  async #aliveMap(runs: readonly ActiveRun[]): Promise<ReadonlyMap<number, boolean>> {
    const identities = runs
      .filter((run) => !run.launchedHere && !run.exit)
      .map((run) => this.#deps.registry.get(run.downloadId)?.process)
      .filter((identity) => identity !== null && identity !== undefined);
    if (identities.length === 0) return NO_LIVENESS;
    const now = this.#deps.clock.now();
    if (now - this.#livenessAt < this.#deps.livenessEveryMs) return NO_LIVENESS;
    this.#livenessAt = now;
    try {
      return await this.#deps.inspector.aliveMany(identities);
    } catch (error) {
      this.#deps.logger.warn('process listing failed', { error: String(error) });
      return NO_LIVENESS;
    }
  }

  #persistThrottled(download: Download, run: ActiveRun): void {
    if (download.logOffset === run.persistedOffset) return;
    const now = this.#deps.clock.now();
    if (now - run.lastPersistAt < this.#deps.persistEveryMs) return;
    run.lastPersistAt = now;
    run.persistedOffset = download.logOffset;
    if (!this.#deps.journal.commit(download)) {
      this.#deps.logger.warn('download row vanished while running', { downloadId: download.id });
    }
  }
}
