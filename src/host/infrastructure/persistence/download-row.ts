/**
 * Mapping between `DownloadRecord` and the `downloads` table row.
 * Reading validates every column (JSON columns included); an invalid row maps to
 * an error string so callers can skip and log it.
 */
import type { SQLInputValue } from 'node:sqlite';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { DownloadRecord } from '../../application/ports/persistence.ts';
import {
  CountersSchema,
  DownloadRowSchema,
  ErrorLinesSchema,
  OutcomeSchema,
  ProcessIdentitySchema,
  RetrySchema,
  parseJsonColumn
} from './row-schemas.ts';

export const DOWNLOAD_COLUMNS = [
  'id',
  'batch_id',
  'source_url',
  'title',
  'engine',
  'scope',
  'status',
  'outcome',
  'legacy_summary',
  'counters',
  'cookie_name',
  'folder_id',
  'position',
  'created_at',
  'started_at',
  'completed_at',
  'updated_at',
  'process',
  'log_file',
  'log_offset',
  'retry',
  'used_browser_cookies',
  'last_error_kind',
  'error_lines'
] as const;

type DownloadColumn = (typeof DOWNLOAD_COLUMNS)[number];

/** Engine error buffers are bounded by the domain (10); keep a hard cap here too. */
const MAX_ERROR_LINES = 50;

export function downloadToParams(record: DownloadRecord): Record<DownloadColumn, SQLInputValue> {
  return {
    id: record.id,
    batch_id: record.batchId,
    source_url: record.sourceUrl,
    title: record.title,
    engine: record.engine,
    scope: record.scope,
    status: record.status,
    outcome: record.outcome ? JSON.stringify(record.outcome) : null,
    legacy_summary: record.legacySummary,
    counters: JSON.stringify(record.counters),
    cookie_name: record.cookieName,
    folder_id: record.folderId,
    position: record.position,
    created_at: record.createdAt,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    updated_at: record.updatedAt,
    process: record.process ? JSON.stringify(record.process) : null,
    log_file: record.logFile,
    log_offset: record.logOffset,
    retry: JSON.stringify(record.retry),
    used_browser_cookies: record.usedBrowserCookies ? 1 : 0,
    last_error_kind: record.lastErrorKind,
    error_lines: JSON.stringify(record.errorLines.slice(-MAX_ERROR_LINES))
  };
}

function column<T>(name: string, result: Result<T, string>): Result<T, string> {
  return result.ok ? result : err(`${name}: ${result.error}`);
}

export function rowToDownload(row: unknown): Result<DownloadRecord, string> {
  const parsed = DownloadRowSchema.parse(row);
  if (!parsed.ok) return err(`${parsed.error.path}: ${parsed.error.reason}`);
  const r = parsed.value;
  const counters = column('counters', parseJsonColumn(r.counters, CountersSchema));
  if (!counters.ok) return counters;
  const retry = column('retry', parseJsonColumn(r.retry, RetrySchema));
  if (!retry.ok) return retry;
  const errorLines = column('error_lines', parseJsonColumn(r.error_lines, ErrorLinesSchema));
  if (!errorLines.ok) return errorLines;
  const outcome = r.outcome === null ? ok(null) : column('outcome', parseJsonColumn(r.outcome, OutcomeSchema));
  if (!outcome.ok) return outcome;
  const process = r.process === null ? ok(null) : column('process', parseJsonColumn(r.process, ProcessIdentitySchema));
  if (!process.ok) return process;
  return ok({
    id: r.id,
    batchId: r.batch_id,
    sourceUrl: r.source_url,
    title: r.title,
    engine: r.engine,
    scope: r.scope,
    status: r.status,
    outcome: outcome.value,
    legacySummary: r.legacy_summary,
    counters: counters.value,
    cookieName: r.cookie_name,
    folderId: r.folder_id,
    position: r.position,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
    process: process.value,
    logFile: r.log_file,
    logOffset: r.log_offset,
    retry: retry.value,
    usedBrowserCookies: r.used_browser_cookies === 1,
    lastErrorKind: r.last_error_kind,
    errorLines: errorLines.value
  });
}

/** `SELECT` list for the downloads table with an optional alias. */
export function downloadColumns(alias?: string): string {
  return DOWNLOAD_COLUMNS.map((name) => (alias ? `${alias}.${name}` : name)).join(', ');
}
