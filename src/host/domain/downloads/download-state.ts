/**
 * Plain state of a `Download` aggregate.
 *
 * Persistence uses a separate `DownloadRecord` (application port). Mapping is
 * explicit in `record-mapper.ts` so either side can evolve without pretending
 * the two types are the same module-level identity.
 */
import {
  EMPTY_DOWNLOAD_COUNTERS,
  isActiveStatus,
  isTerminalStatus,
  type DownloadCounters,
  type DownloadOutcome,
  type DownloadStatus
} from '../../../shared/domain/download.ts';
import type { DownloadScope, Engine } from '../../../shared/domain/engine.ts';
import type { EngineErrorKind } from '../engines/parsed-line.ts';
import type { ProcessIdentity } from '../processes/process-identity.ts';

export type { DownloadCounters, DownloadOutcome, DownloadStatus };

/** yt-dlp browser-cookie override for the next run (`skip` = never, `force` = always). */
export type CookieRetryMode = 'skip' | 'force';

export interface RetryState {
  readonly browserCookieMode: CookieRetryMode | null;
  readonly skipTried: boolean;
  readonly forceTried: boolean;
}

export interface DownloadState {
  readonly id: string;
  readonly batchId: string | null;
  readonly sourceUrl: string;
  readonly title: string;
  readonly engine: Engine;
  readonly scope: DownloadScope;
  readonly status: DownloadStatus;
  readonly outcome: DownloadOutcome | null;
  readonly legacySummary: string | null;
  readonly counters: DownloadCounters;
  readonly cookieName: string | null;
  readonly folderId: string | null;
  readonly position: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly updatedAt: number;
  readonly process: ProcessIdentity | null;
  readonly logFile: string | null;
  readonly logOffset: number;
  readonly retry: RetryState;
  readonly usedBrowserCookies: boolean;
  readonly lastErrorKind: EngineErrorKind | null;
  readonly errorLines: readonly string[];
}

/** Live, non-persisted progress of the current run. */
export interface DownloadProgress {
  /** 0–100 of the current file, `null` when unknown. */
  readonly percent: number | null;
  readonly speed: string | null;
  readonly eta: string | null;
  readonly currentFile: string | null;
}

export const EMPTY_COUNTERS: DownloadCounters = EMPTY_DOWNLOAD_COUNTERS;

export const INITIAL_RETRY: RetryState = { browserCookieMode: null, skipTried: false, forceTried: false };

export const EMPTY_PROGRESS: DownloadProgress = { percent: null, speed: null, eta: null, currentFile: null };

/** Max engine error messages kept per download. */
export const MAX_ERROR_LINES = 10;

/** Host-local aliases of the shared domain predicates. */
export const isActiveDownloadStatus = isActiveStatus;
export const isTerminalDownloadStatus = isTerminalStatus;

export interface NewDownload {
  readonly id: string;
  readonly batchId: string | null;
  readonly sourceUrl: string;
  readonly title: string;
  readonly engine: Engine;
  readonly scope: DownloadScope;
  readonly cookieName: string | null;
  readonly folderId: string | null;
  readonly position: number;
  readonly now: number;
}

/** State of a freshly queued download. */
export function initialDownloadState(input: NewDownload): DownloadState {
  return {
    id: input.id,
    batchId: input.batchId,
    sourceUrl: input.sourceUrl,
    title: input.title,
    engine: input.engine,
    scope: input.scope,
    status: 'pending',
    outcome: null,
    legacySummary: null,
    counters: EMPTY_COUNTERS,
    cookieName: input.cookieName,
    folderId: input.folderId,
    position: input.position,
    createdAt: input.now,
    startedAt: null,
    completedAt: null,
    updatedAt: input.now,
    process: null,
    logFile: null,
    logOffset: 0,
    retry: INITIAL_RETRY,
    usedBrowserCookies: false,
    lastErrorKind: null,
    errorLines: []
  };
}
