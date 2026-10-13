/**
 * `Download` aggregate — one download (= one conversation in the UI).
 *
 * State machine (spec 02 §1.9, with the rewrite fixes):
 *
 *   pending ──markRunning──▶ running ──finish──▶ completed | failed
 *      │  ▲                    │ │ │└─requeueForRetry / requeueOnExit──▶ pending
 *      │  └──resume── paused ◀─┘ │ pause
 *      │pause           ▲        │
 *      └────────────────┘        └─cancel──▶ cancelled ◀─cancel── pending | paused
 *   completed | failed | cancelled ──restart──▶ pending
 *   pending ──finish (launch failure)──▶ failed
 *
 * Invalid transitions return `Result` errors instead of throwing. State patches
 * live in `download-transitions.ts`, line accounting in `line-accounting.ts`.
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { DownloadScope, Engine } from '../../../shared/domain/engine.ts';
import type { DownloadStatus } from '../../../shared/domain/download.ts';
import type { EngineErrorKind, ParsedLine } from '../engines/parsed-line.ts';
import type { ProcessIdentity } from '../processes/process-identity.ts';
import {
  initialDownloadState,
  isActiveDownloadStatus,
  isTerminalDownloadStatus,
  type CookieRetryMode,
  type DownloadCounters,
  type DownloadOutcome,
  type DownloadProgress,
  type DownloadState,
  type NewDownload,
  type RetryState
} from './download-state.ts';
import {
  requeuePatch,
  restartPatch,
  retryPatch,
  runStartPatch,
  transitionError,
  type RunStart,
  type StatePatch
} from './download-transitions.ts';
import type { DownloadEvent, PauseCause } from './events.ts';
import { applyParsedLine, NO_EFFECT, type LineEffect } from './line-accounting.ts';
import { cancelledOutcome, statusForOutcome } from './outcome-policy.ts';
import { RunProgress } from './run-progress.ts';

export type { NewDownload } from './download-state.ts';
export type { RunStart } from './download-transitions.ts';
export type { LineEffect } from './line-accounting.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class Download {
  #state: Mutable<DownloadState>;
  readonly #run = new RunProgress();
  #events: DownloadEvent[] = [];

  private constructor(state: DownloadState) {
    this.#state = { ...state, errorLines: [...state.errorLines] };
  }

  static create(input: NewDownload): Download {
    const download = new Download(initialDownloadState(input));
    download.#emit({ type: 'created', downloadId: input.id, at: input.now });
    return download;
  }

  /** Rehydrates a persisted download (no events). */
  static restore(state: DownloadState): Download {
    return new Download(state);
  }

  toState(): DownloadState {
    return { ...this.#state, errorLines: [...this.#state.errorLines] };
  }

  /* ───────────── Queries ───────────── */

  get id(): string {
    return this.#state.id;
  }
  get batchId(): string | null {
    return this.#state.batchId;
  }
  get sourceUrl(): string {
    return this.#state.sourceUrl;
  }
  get title(): string {
    return this.#state.title;
  }
  get engine(): Engine {
    return this.#state.engine;
  }
  get scope(): DownloadScope {
    return this.#state.scope;
  }
  get status(): DownloadStatus {
    return this.#state.status;
  }
  get outcome(): DownloadOutcome | null {
    return this.#state.outcome;
  }
  get counters(): DownloadCounters {
    return this.#state.counters;
  }
  get cookieName(): string | null {
    return this.#state.cookieName;
  }
  get position(): number {
    return this.#state.position;
  }
  get createdAt(): number {
    return this.#state.createdAt;
  }
  get startedAt(): number | null {
    return this.#state.startedAt;
  }
  get completedAt(): number | null {
    return this.#state.completedAt;
  }
  get process(): ProcessIdentity | null {
    return this.#state.process;
  }
  get logFile(): string | null {
    return this.#state.logFile;
  }
  get logOffset(): number {
    return this.#state.logOffset;
  }
  get retry(): RetryState {
    return this.#state.retry;
  }
  get usedBrowserCookies(): boolean {
    return this.#state.usedBrowserCookies;
  }
  get lastErrorKind(): EngineErrorKind | null {
    return this.#state.lastErrorKind;
  }
  get errorLines(): readonly string[] {
    return this.#state.errorLines;
  }
  get lastErrorLine(): string | null {
    return this.#state.errorLines.at(-1) ?? null;
  }
  get isActive(): boolean {
    return isActiveDownloadStatus(this.#state.status);
  }
  /** Live progress of the current run (not persisted). */
  get progress(): DownloadProgress {
    return this.#run.progress;
  }

  /* ───────────── Transitions ───────────── */

  markRunning(start: RunStart): Result<void, AppErrorData> {
    const from = this.#state.status;
    if (from !== 'pending') return transitionError(ErrorCode.DOWNLOAD_INVALID_TRANSITION, from, 'start');
    this.#patch(runStartPatch(start));
    this.attachRun(start.knownFiles);
    this.#emit({ type: 'started', downloadId: this.id, engine: this.engine, at: start.now });
    return ok();
  }

  /**
   * Prepares per-run bookkeeping for a running download (also used when a restarted
   * host re-attaches). Known files are only ignored when `done` was carried over,
   * otherwise re-detections must be counted again (e.g. as skipped after a restart).
   */
  attachRun(knownFiles: Iterable<string>): void {
    this.#run.reset(this.#state.counters.done > 0 ? knownFiles : []);
  }

  pause(now: number, cause: PauseCause = 'user'): Result<void, AppErrorData> {
    const from = this.#state.status;
    if (from === 'paused') return ok();
    if (from !== 'pending' && from !== 'running') {
      return transitionError(ErrorCode.DOWNLOAD_NOT_ACTIVE, from, 'pause');
    }
    this.#endRun();
    this.#state.status = 'paused';
    this.#emit({ type: 'paused', downloadId: this.id, wasRunning: from === 'running', cause, at: now });
    return ok();
  }

  /** Re-queues a paused download (see `requeuePatch`). */
  resume(now: number): Result<void, AppErrorData> {
    const from = this.#state.status;
    if (from !== 'paused') return transitionError(ErrorCode.DOWNLOAD_NOT_PAUSED, from, 'resume');
    this.#patch(requeuePatch(this.#state.counters));
    this.#emit({ type: 'resumed', downloadId: this.id, at: now });
    return ok();
  }

  /**
   * The app quit while this download ran and its engine was stopped: it goes back
   * to the queue at its original position and resumes automatically on the next
   * launch (recorded on the timeline as a pause caused by the exit).
   */
  requeueOnExit(now: number): Result<void, AppErrorData> {
    const from = this.#state.status;
    if (from !== 'running') return transitionError(ErrorCode.DOWNLOAD_INVALID_TRANSITION, from, 'requeue');
    this.#endRun();
    this.#patch(requeuePatch(this.#state.counters));
    this.#emit({ type: 'paused', downloadId: this.id, wasRunning: true, cause: 'shutdown', at: now });
    return ok();
  }

  cancel(now: number): Result<void, AppErrorData> {
    const from = this.#state.status;
    if (!isActiveDownloadStatus(from)) return transitionError(ErrorCode.DOWNLOAD_NOT_ACTIVE, from, 'cancel');
    this.#endRun();
    this.#patch({ status: 'cancelled', outcome: cancelledOutcome(), completedAt: now });
    this.#emit({ type: 'cancelled', downloadId: this.id, wasRunning: from === 'running', at: now });
    return ok();
  }

  /** Terminal → pending with a clean slate, at `position` in the queue. */
  restart(now: number, position: number): Result<void, AppErrorData> {
    const from = this.#state.status;
    if (!isTerminalDownloadStatus(from)) {
      return transitionError(ErrorCode.DOWNLOAD_STILL_ACTIVE, from, 'restart');
    }
    this.#endRun();
    this.#patch(restartPatch(position));
    this.#emit({ type: 'restarted', downloadId: this.id, at: now });
    return ok();
  }

  /** Records the result of a run (or of a launch failure while still pending). */
  finish(outcome: DownloadOutcome, now: number): Result<void, AppErrorData> {
    const from = this.#state.status;
    if (from !== 'running' && from !== 'pending') {
      return transitionError(ErrorCode.DOWNLOAD_INVALID_TRANSITION, from, 'finish');
    }
    const status = statusForOutcome(outcome.kind);
    if (status === 'cancelled') return this.cancel(now);
    this.#endRun();
    this.#patch({ status, outcome, completedAt: now });
    this.#emit({ type: 'finished', downloadId: this.id, status, outcome, counters: this.counters, at: now });
    return ok();
  }

  /** yt-dlp cookie retry: the failed run is discarded and the download queued again. */
  requeueForRetry(mode: CookieRetryMode, now: number): Result<void, AppErrorData> {
    const from = this.#state.status;
    if (from !== 'running') return transitionError(ErrorCode.DOWNLOAD_INVALID_TRANSITION, from, 'retry');
    this.#endRun();
    this.#patch(retryPatch(mode, this.#state.retry));
    this.#emit({ type: 'retry-scheduled', downloadId: this.id, mode, at: now });
    return ok();
  }

  /* ───────────── Run supervision ───────────── */

  /** Applies one parsed engine line. Ignored unless the download is running. */
  applyLine(line: ParsedLine): LineEffect {
    if (this.#state.status !== 'running') return NO_EFFECT;
    const { counters, errorLines, lastErrorKind } = this.#state;
    const applied = applyParsedLine(line, { counters, errorLines, lastErrorKind }, this.#run);
    this.#patch(applied.accounting);
    return applied.effect;
  }

  advanceLog(offset: number): void {
    if (Number.isFinite(offset) && offset >= 0) this.#state.logOffset = offset;
  }

  pullEvents(): DownloadEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /* ───────────── Internals ───────────── */

  #endRun(): void {
    this.#state.process = null;
    this.#run.clearProgress();
  }

  #patch(patch: StatePatch): void {
    Object.assign(this.#state, patch);
  }

  #emit(event: DownloadEvent): void {
    this.#events.push(event);
  }
}
