/**
 * Starts pending downloads that fit in the weighted slot budget (position order,
 * lighter downloads may overtake a heavier head that does not fit).
 *
 * A launch has three phases so the downloads mutex is never held during slow work
 * (workspace, cookie decryption, browser detection, spawn, OS identity capture):
 *  1. `reserve` (under the mutex): plan, and mark the chosen downloads as launching
 *     (their weight counts against the budget until the commit);
 *  2. `launch` (outside the mutex): prepare and spawn. Right after the spawn the
 *     process is persisted on the row (status running), so a host crash before the
 *     commit never leads to a second engine: the next host re-attaches instead;
 *  3. `commit` (under the mutex): the download becomes running — unless it was
 *     paused, stopped, restarted or forgotten meanwhile (or the host is shutting
 *     down in pause mode): the fresh process is then terminated and released.
 */
import type { Clock } from '../../../shared/kernel/clock.ts';
import { err, type Result } from '../../../shared/kernel/result.ts';
import { Download } from '../../domain/downloads/download.ts';
import { OUTCOME_REASONS } from '../../domain/downloads/outcome-policy.ts';
import type { SlotBudget } from '../../domain/downloads/slot-budget.ts';
import type { EngineRegistry } from '../ports/engines.ts';
import type { LaunchedProcess } from '../ports/processes.ts';
import type { MediaFileRepository } from '../ports/persistence.ts';
import type { Logger } from '../ports/system.ts';
import type { ActiveRun, DownloadRegistry } from './download-registry.ts';
import type { Finisher } from './finisher.ts';
import type { DownloadJournal } from './journal.ts';
import type { LaunchFailure, LaunchService, LaunchSuccess, LaunchTarget } from './launch-service.ts';
import type { ProcessControl } from './process-control.ts';

export interface SchedulerDeps {
  readonly registry: DownloadRegistry;
  readonly budget: SlotBudget;
  readonly engines: EngineRegistry;
  readonly launcher: LaunchService;
  readonly processes: ProcessControl;
  readonly finisher: Finisher;
  readonly journal: DownloadJournal;
  readonly files: MediaFileRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** While true (runtime tools being installed/updated) nothing is launched. */
  readonly runtimeBusy: (() => boolean) | null;
  /** Called for every run that started (wires exit notification + supervision). */
  readonly onRunStarted: (run: ActiveRun, process: LaunchedProcess) => void;
}

/** A download chosen by `reserve`, launching until its attempt is committed. */
export interface Reservation {
  /** The exact in-memory download: a restarted download is a new object and gets a new launch. */
  readonly download: Download;
  readonly target: LaunchTarget;
  readonly weight: number;
}

export interface LaunchAttempt {
  readonly reservation: Reservation;
  readonly result: Result<LaunchSuccess, LaunchFailure>;
}

interface Launching {
  readonly reservation: Reservation;
  attempt: Promise<LaunchAttempt> | null;
  /** The spawned process was written to the row (it must be rewritten if discarded). */
  persisted: boolean;
}

export class Scheduler {
  readonly #deps: SchedulerDeps;
  readonly #launching = new Map<string, Launching>();

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  /** Phase 1 (under the mutex): reserves what fits now. */
  reserve(): Reservation[] {
    const { registry, budget } = this.#deps;
    if (this.#runtimeBusy()) return [];
    const used = budget.used([
      ...registry.withStatus('running').map((download) => this.#weightOf(download)),
      ...[...this.#launching.values()].map((entry) => entry.reservation.weight)
    ]);
    const candidates = registry
      .withStatus('pending')
      .filter((download) => !this.#launching.has(download.id) && !registry.isForgotten(download.id));
    const plan = budget.plan(
      candidates.map((download) => ({
        id: download.id,
        position: download.position,
        weight: this.#weightOf(download)
      })),
      used
    );
    const reservations: Reservation[] = [];
    for (const id of plan) {
      const download = registry.get(id);
      if (!download) continue;
      const { engine, sourceUrl, cookieName, retry } = download;
      const reservation: Reservation = {
        download,
        target: { id, engine, sourceUrl, cookieName, retry },
        weight: this.#weightOf(download)
      };
      this.#launching.set(id, { reservation, attempt: null, persisted: false });
      reservations.push(reservation);
    }
    return reservations;
  }

  /** Phase 2 (outside the mutex): prepares and spawns. Never rejects. */
  launch(reservation: Reservation): Promise<LaunchAttempt> {
    const attempt = this.#attempt(reservation);
    const entry = this.#launching.get(reservation.target.id);
    if (entry?.reservation === reservation) entry.attempt = attempt;
    return attempt;
  }

  /** Attempts reserved but not committed yet (host shutdown waits for them). */
  pendingAttempts(): Promise<LaunchAttempt>[] {
    return [...this.#launching.values()].flatMap((entry) => (entry.attempt ? [entry.attempt] : []));
  }

  launchingIds(): string[] {
    return [...this.#launching.keys()];
  }

  /** True from `reserve` until the attempt is committed (an engine may be starting). */
  isLaunching(downloadId: string): boolean {
    return this.#launching.has(downloadId);
  }

  /**
   * Phase 3 (under the mutex). `discard`: never start the run (host shutting down
   * in pause mode). Returns true when the download changed state. Idempotent: an
   * attempt already committed is ignored.
   */
  async commit(attempt: LaunchAttempt, options: { readonly discard: boolean }): Promise<boolean> {
    const { registry, finisher, logger } = this.#deps;
    const { reservation, result } = attempt;
    const id = reservation.target.id;
    const entry = this.#launching.get(id);
    if (entry?.reservation !== reservation) return false;
    this.#launching.delete(id);
    const download = registry.get(id);
    const wanted =
      !options.discard &&
      download === reservation.download &&
      download.status === 'pending' &&
      !registry.isForgotten(id);
    if (!result.ok) {
      if (!wanted || !download) {
        await this.#settleUnwanted(reservation);
        return false;
      }
      logger.warn('download launch failed', { downloadId: id, reason: result.error.reason });
      await finisher.finishLaunchFailure(download, result.error);
      return true;
    }
    if (!wanted || !download) {
      await this.#discard(reservation, result.value, entry.persisted);
      return false;
    }
    this.#start(download, result.value);
    return true;
  }

  async #attempt(reservation: Reservation): Promise<LaunchAttempt> {
    let result: Result<LaunchSuccess, LaunchFailure>;
    try {
      result = await this.#deps.launcher.launch(reservation.target);
    } catch (error) {
      this.#deps.logger.error('download launch threw', { downloadId: reservation.target.id, error: String(error) });
      result = err({ reason: OUTCOME_REASONS.spawnFailed, detail: null });
    }
    if (result.ok) this.#persistSpawn(reservation, result.value);
    return { reservation, result };
  }

  /**
   * Crash safety: records the spawned process on the row right away (outside the
   * mutex; a synchronous write cannot interleave with other code). Skipped when the
   * download moved on meanwhile — the commit then terminates the process.
   */
  #persistSpawn(reservation: Reservation, success: LaunchSuccess): void {
    const { registry, journal, clock, logger } = this.#deps;
    const id = reservation.target.id;
    const entry = this.#launching.get(id);
    const download = registry.get(id);
    if (entry?.reservation !== reservation || download !== reservation.download) return;
    if (download.status !== 'pending' || registry.isForgotten(id)) return;
    try {
      const draft = Download.restore(download.toState());
      const started = draft.markRunning({
        process: success.process.identity,
        logFile: success.logFile,
        usedBrowserCookies: success.usedBrowserCookies,
        knownFiles: [],
        now: clock.now()
      });
      if (!started.ok) return;
      // The timeline entry is written by the commit.
      draft.pullEvents();
      entry.persisted = journal.commit(draft) !== null;
    } catch (error) {
      logger.warn('persisting the launched process failed', { downloadId: id, error: String(error) });
    }
  }

  #start(download: Download, success: LaunchSuccess): void {
    const { registry, journal, files, clock, logger, onRunStarted } = this.#deps;
    const { run, process, logFile, usedBrowserCookies } = success;
    const knownFiles = download.counters.done > 0 ? files.pathsByConversation(download.id) : [];
    download.markRunning({ process: process.identity, logFile, usedBrowserCookies, knownFiles, now: clock.now() });
    registry.setRun(run);
    onRunStarted(run, process);
    if (!journal.commit(download)) {
      logger.warn('download row vanished at launch', { downloadId: download.id });
      return;
    }
    journal.changed(download.id, 'started');
  }

  /** The launched process is not wanted: terminate it, release its workspace, restore the row. */
  async #discard(reservation: Reservation, success: LaunchSuccess, persisted: boolean): Promise<void> {
    const { registry, processes, finisher, journal, logger } = this.#deps;
    const id = reservation.target.id;
    const stopped = await processes.stop(success.process.identity, success.run);
    if (stopped === 'failed') logger.error('unwanted engine process could not be terminated', { downloadId: id });
    const forgotten = registry.isForgotten(id);
    await finisher.release(id, success.run, { absorbCookie: false });
    const download = registry.get(id);
    // The row may say "running" (persisted spawn): write the in-memory state back.
    if (persisted && !forgotten && download === reservation.download) journal.commit(download);
    // A surviving engine may still write its log: never compact it (a forgotten one is removed anyway).
    // It runs unsupervised from here; the next start-up sweep removes its job dir, its log stays whole.
    if (stopped !== 'failed' || forgotten) await this.#settleUnwanted(reservation);
  }

  /**
   * Workspace of an attempt that will not run (its engine, if any, is gone). Its
   * secrets are already removed (by the failed launch, or by `release` on discard);
   * what is left depends on the download:
   * - forgotten: its job log was re-created after `forget` cleaned up — remove all;
   * - still queued or paused: keep its temp files for the next run;
   * - ended while launching (stopped) or replaced by a restart: retire the job
   *   (`retire` also removes the log when the row was deleted meanwhile).
   */
  async #settleUnwanted(reservation: Reservation): Promise<void> {
    const { registry, finisher } = this.#deps;
    const id = reservation.target.id;
    if (registry.isForgotten(id)) await finisher.retire(id, { removeLog: true });
    else if (registry.get(id) !== reservation.download) await finisher.retire(id);
  }

  #runtimeBusy(): boolean {
    try {
      return this.#deps.runtimeBusy?.() === true;
    } catch (error) {
      this.#deps.logger.warn('runtime busy probe failed', { error: String(error) });
      return false;
    }
  }

  #weightOf(download: Download): number {
    try {
      return this.#deps.engines.get(download.engine).slotWeight;
    } catch {
      return 1;
    }
  }
}
