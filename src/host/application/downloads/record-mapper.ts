/**
 * Maps the domain `DownloadState` to the persistence `DownloadRecord` and back.
 *
 * Field-by-field on purpose: the two types are intentionally similar (same
 * lifecycle bookkeeping) but live in different layers. An explicit mapper keeps
 * the persistence boundary visible when either side gains or drops a field.
 *
 * Fields owned by other use cases (title — rename; folderId — move to folder;
 * legacySummary — legacy import) are taken from the stored row when it exists, so
 * the downloads core never overwrites a concurrent rename/move with a stale value.
 */
import type { DownloadState } from '../../domain/downloads/download-state.ts';
import type { DownloadRecord } from '../ports/persistence.ts';

export function toRecord(state: DownloadState, existing: DownloadRecord | null, now: number): DownloadRecord {
  return {
    id: state.id,
    batchId: state.batchId,
    sourceUrl: state.sourceUrl,
    title: existing ? existing.title : state.title,
    engine: state.engine,
    scope: state.scope,
    status: state.status,
    outcome: state.outcome,
    legacySummary: existing ? existing.legacySummary : state.legacySummary,
    counters: state.counters,
    cookieName: state.cookieName,
    folderId: existing ? existing.folderId : state.folderId,
    position: state.position,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    updatedAt: now,
    process: state.process,
    logFile: state.logFile,
    logOffset: state.logOffset,
    retry: {
      browserCookieMode: state.retry.browserCookieMode,
      skipTried: state.retry.skipTried,
      forceTried: state.retry.forceTried
    },
    usedBrowserCookies: state.usedBrowserCookies,
    lastErrorKind: state.lastErrorKind,
    errorLines: [...state.errorLines]
  };
}

export function fromRecord(record: DownloadRecord): DownloadState {
  return {
    id: record.id,
    batchId: record.batchId,
    sourceUrl: record.sourceUrl,
    title: record.title,
    engine: record.engine,
    scope: record.scope,
    status: record.status,
    outcome: record.outcome,
    legacySummary: record.legacySummary,
    counters: record.counters,
    cookieName: record.cookieName,
    folderId: record.folderId,
    position: record.position,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt,
    process: record.process,
    logFile: record.logFile,
    logOffset: record.logOffset,
    retry: {
      browserCookieMode: record.retry.browserCookieMode,
      skipTried: record.retry.skipTried,
      forceTried: record.retry.forceTried
    },
    usedBrowserCookies: record.usedBrowserCookies,
    lastErrorKind: record.lastErrorKind,
    errorLines: [...record.errorLines]
  };
}
