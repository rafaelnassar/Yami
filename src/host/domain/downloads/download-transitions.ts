/**
 * State patches applied by the `Download` transitions (kept apart so the
 * aggregate only holds the guards and the event emission).
 */
import { appError, type AppErrorData, type ErrorCode } from '../../../shared/kernel/errors.ts';
import { err, type Result } from '../../../shared/kernel/result.ts';
import type { DownloadStatus } from '../../../shared/domain/download.ts';
import type { ProcessIdentity } from '../processes/process-identity.ts';
import {
  EMPTY_COUNTERS,
  INITIAL_RETRY,
  type CookieRetryMode,
  type DownloadCounters,
  type DownloadState,
  type RetryState
} from './download-state.ts';

export interface RunStart {
  readonly process: ProcessIdentity;
  readonly logFile: string;
  readonly usedBrowserCookies: boolean;
  /** Paths already stored for this conversation (skipped from counting when `done` is carried over). */
  readonly knownFiles: Iterable<string>;
  readonly now: number;
}

export type StatePatch = Partial<DownloadState>;

export function transitionError(code: ErrorCode, from: DownloadStatus, action: string): Result<never, AppErrorData> {
  return err(appError(code, { from, action }));
}

export function runStartPatch(start: RunStart): StatePatch {
  return {
    status: 'running',
    process: start.process,
    logFile: start.logFile,
    logOffset: 0,
    startedAt: start.now,
    completedAt: null,
    outcome: null,
    usedBrowserCookies: start.usedBrowserCookies
  };
}

/**
 * Back to the queue (resume, or app quit while running). Engines skip what is
 * already on disk, so `done` is kept (those files are ignored when re-detected)
 * while skipped/errors are recounted by the next run.
 */
export function requeuePatch(counters: DownloadCounters): StatePatch {
  return {
    status: 'pending',
    logOffset: 0,
    counters: { ...counters, skipped: 0, errors: 0 },
    errorLines: [],
    lastErrorKind: null
  };
}

/** Terminal → pending with a clean slate (counters, outcome, errors and retry flags). */
export function restartPatch(position: number): StatePatch {
  return {
    status: 'pending',
    position,
    outcome: null,
    counters: EMPTY_COUNTERS,
    startedAt: null,
    completedAt: null,
    logOffset: 0,
    retry: INITIAL_RETRY,
    usedBrowserCookies: false,
    lastErrorKind: null,
    errorLines: []
  };
}

/** yt-dlp cookie retry: the failed run is discarded and the download queued again. */
export function retryPatch(mode: CookieRetryMode, retry: RetryState): StatePatch {
  return {
    status: 'pending',
    outcome: null,
    counters: EMPTY_COUNTERS,
    logOffset: 0,
    usedBrowserCookies: false,
    lastErrorKind: null,
    errorLines: [],
    retry: {
      browserCookieMode: mode,
      skipTried: retry.skipTried || mode === 'skip',
      forceTried: retry.forceTried || mode === 'force'
    }
  };
}
