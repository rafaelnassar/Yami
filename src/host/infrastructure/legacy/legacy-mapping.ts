/**
 * Pure mapping of legacy rows/jobs to the new persistence records.
 * Active legacy downloads (pending/running/paused) become `paused`: legacy
 * engine processes are never re-attached, the user resumes them explicitly.
 */
import type { DownloadStatus } from '../../../shared/contracts/dto.ts';
import type { DownloadScope } from '../../../shared/domain/engine.ts';
import { baseName, extensionOf, isSidecarFile, mediaTypeOf } from '../../../shared/domain/media.ts';
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';
import type { BatchRecord, DownloadRecord, NewMediaFile } from '../../application/ports/persistence.ts';
import type { LegacyConversationEvent } from '../persistence/event-repository.ts';
import type { LegacyBatchRow, LegacyConversationRow, LegacyEventRow, LegacyFileRow } from './legacy-database-reader.ts';
import type { LegacyJob, LegacyStateBatch } from './legacy-files.ts';

const EVENT_LEVELS = new Set(['info', 'success', 'warning', 'error']);
const TERMINAL: ReadonlySet<DownloadStatus> = new Set(['completed', 'failed', 'cancelled']);

export const LEGACY_EVENT_CODE = 'legacy';

function importedStatus(status: DownloadStatus): DownloadStatus {
  return TERMINAL.has(status) ? status : 'paused';
}

function toInt(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Hostname (without `www.`) as a last-resort title. */
export function fallbackTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url.slice(0, LIMITS.maxTitleLength);
  } catch {
    return url.slice(0, LIMITS.maxTitleLength);
  }
}

/** Maps a legacy absolute cookie path to the imported vault name (by basename only). */
export function legacyCookieName(
  cookiesPath: string | null | undefined,
  names: ReadonlyMap<string, string>
): string | null {
  if (!cookiesPath) return null;
  return names.get(baseName(cookiesPath)) ?? null;
}

const DEFAULT_RETRY = { browserCookieMode: null, skipTried: false, forceTried: false } as const;

export interface RecordContext {
  readonly position: number;
  readonly scope: DownloadScope;
  readonly batchId: string | null;
  readonly titleFor: (url: string) => string;
}

export function conversationToRecord(row: LegacyConversationRow, context: RecordContext): DownloadRecord {
  const status = importedStatus(row.status);
  const title = row.title.trim().slice(0, LIMITS.maxTitleLength) || context.titleFor(row.source_url);
  return {
    id: row.id,
    batchId: context.batchId,
    sourceUrl: row.source_url,
    title,
    engine: row.engine,
    scope: context.scope,
    status,
    outcome: null,
    legacySummary: row.summary.trim() || null,
    counters: { done: row.files_downloaded, skipped: row.files_skipped, errors: row.errors_count },
    cookieName: null,
    folderId: null,
    position: context.position,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: TERMINAL.has(status) ? row.completed_at : null,
    updatedAt: row.updated_at,
    process: null,
    logFile: null,
    logOffset: 0,
    retry: DEFAULT_RETRY,
    usedBrowserCookies: false,
    lastErrorKind: null,
    errorLines: []
  };
}

export interface JobContext extends RecordContext {
  readonly now: number;
  readonly cookieName: string | null;
  /** Row already mapped from the legacy database for the same id (state.json is fresher). */
  readonly fromDatabase: DownloadRecord | null;
}

/** An active `state.json` job as a paused download. */
export function jobToRecord(job: LegacyJob, context: JobContext): DownloadRecord {
  const base = context.fromDatabase;
  const createdAt = toInt(job.createdAt) ?? base?.createdAt ?? toInt(job.startedAt) ?? context.now;
  const counters = job.stats ?? base?.counters ?? { done: 0, skipped: 0, errors: 0 };
  return {
    id: job.id,
    batchId: context.batchId,
    sourceUrl: job.url,
    title: base?.title ?? context.titleFor(job.url),
    engine: job.engine,
    scope: context.scope,
    status: 'paused',
    outcome: null,
    legacySummary: base?.legacySummary ?? null,
    counters,
    cookieName: context.cookieName,
    folderId: null,
    position: context.position,
    createdAt,
    startedAt: toInt(job.startedAt) ?? base?.startedAt ?? null,
    completedAt: null,
    updatedAt: Math.max(base?.updatedAt ?? 0, createdAt),
    process: null,
    logFile: null,
    logOffset: 0,
    retry: DEFAULT_RETRY,
    usedBrowserCookies: false,
    lastErrorKind: null,
    errorLines: []
  };
}

export function databaseBatchToRecord(row: LegacyBatchRow): BatchRecord {
  // Finished legacy batches were already notified by the old app.
  const finished = TERMINAL.has(row.status);
  return {
    id: row.id,
    engine: row.engine,
    scope: row.scope,
    total: row.total_items,
    createdAt: row.created_at,
    notifiedAt: finished ? (row.completed_at ?? row.created_at) : null
  };
}

export function stateBatchToRecord(batch: LegacyStateBatch, base: BatchRecord | null): BatchRecord {
  return {
    id: batch.id,
    engine: batch.engine,
    scope: batch.scope === 'single' ? 'single' : 'bulk',
    total: batch.total,
    createdAt: Math.trunc(batch.createdAt),
    notifiedAt: toInt(batch.finalNotifiedAt) ?? base?.notifiedAt ?? null
  };
}

/** `null` for sidecar rows (never media in the new app). */
export function fileToMediaFile(row: LegacyFileRow, conversationId: string): NewMediaFile | null {
  const name = (row.name.trim() || baseName(row.path)).normalize('NFC');
  if (isSidecarFile(name)) return null;
  return {
    conversationId,
    path: row.path,
    name,
    mediaType: mediaTypeOf(name),
    extension: extensionOf(name),
    sizeBytes: row.size_bytes,
    createdAt: row.created_at
  };
}

export function eventToLegacyEvent(row: LegacyEventRow, conversationId: string): LegacyConversationEvent {
  const level = EVENT_LEVELS.has(row.level) ? (row.level as LegacyConversationEvent['level']) : 'info';
  return {
    conversationId,
    type: 'legacy',
    level,
    code: LEGACY_EVENT_CODE,
    // The original event type lets the UI pick an icon; the text is shown as-is.
    params: { legacyType: row.event_type.slice(0, 32) },
    legacyMessage: row.message,
    createdAt: row.created_at
  };
}
