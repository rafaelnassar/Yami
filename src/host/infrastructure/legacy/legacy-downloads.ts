/**
 * Imports legacy batches and conversations (history rows from the legacy
 * database merged with the active jobs of `state.json`).
 */
import { isActiveStatus } from '../../../shared/domain/download.ts';
import type { DownloadScope } from '../../../shared/domain/engine.ts';
import type { BatchRecord, PersistenceContext } from '../../application/ports/persistence.ts';
import type { Logger } from '../../application/ports/system.ts';
import type { LegacyConversationEvent } from '../persistence/event-repository.ts';
import type { InternalMarkers } from '../persistence/settings-repository.ts';
import { describeError } from '../persistence/silent-logger.ts';
import type { LegacyConversationRow, LegacyDatabaseReader } from './legacy-database-reader.ts';
import type { LegacyJob, LegacyState } from './legacy-files.ts';
import {
  conversationToRecord,
  databaseBatchToRecord,
  eventToLegacyEvent,
  fileToMediaFile,
  jobToRecord,
  legacyCookieName,
  stateBatchToRecord
} from './legacy-mapping.ts';

/** What the importer needs from persistence (implemented by `SqlitePersistenceContext`). */
export interface LegacyImportTarget extends PersistenceContext {
  readonly events: PersistenceContext['events'] & { appendLegacy(event: LegacyConversationEvent): void };
  readonly markers: InternalMarkers;
}

export interface DownloadImportCounts {
  readonly conversations: number;
  readonly pausedDownloads: number;
  readonly batches: number;
  readonly files: number;
  readonly events: number;
  readonly skipped: number;
}

export interface DownloadImportInput {
  readonly target: LegacyImportTarget;
  readonly reader: LegacyDatabaseReader | null;
  readonly state: LegacyState | null;
  readonly cookieNames: ReadonlyMap<string, string>;
  readonly now: number;
  readonly titleFor: (url: string) => string;
  readonly logger: Logger;
}

interface Candidate {
  readonly id: string;
  readonly row: LegacyConversationRow | null;
  readonly job: LegacyJob | null;
  readonly createdAt: number;
}

function collectBatches(input: DownloadImportInput): Map<string, BatchRecord> {
  const batches = new Map<string, BatchRecord>();
  for (const row of input.reader?.batches() ?? []) batches.set(row.id, databaseBatchToRecord(row));
  for (const batch of input.state?.batches.values() ?? []) {
    batches.set(batch.id, stateBatchToRecord(batch, batches.get(batch.id) ?? null));
  }
  return batches;
}

function collectCandidates(input: DownloadImportInput): Candidate[] {
  const rows = new Map((input.reader?.conversations() ?? []).map((row) => [row.id, row] as const));
  const jobs = new Map(
    (input.state?.jobs ?? []).filter((job) => isActiveStatus(job.status)).map((job) => [job.id, job] as const)
  );
  const candidates: Candidate[] = [];
  for (const id of new Set([...rows.keys(), ...jobs.keys()])) {
    // Already imported by an earlier (interrupted) run.
    if (input.target.downloads.get(id) !== null) continue;
    const row = rows.get(id) ?? null;
    const job = jobs.get(id) ?? null;
    const createdAt = row?.created_at ?? Math.trunc(job?.createdAt ?? job?.startedAt ?? input.now);
    candidates.push({ id, row, job, createdAt });
  }
  // Oldest first so scheduling positions follow the legacy order.
  return candidates.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function importLegacyDownloads(input: DownloadImportInput): DownloadImportCounts {
  const { target, logger } = input;
  const batchRecords = collectBatches(input);
  const newBatches = [...batchRecords.values()].filter((batch) => target.batches.get(batch.id) === null);
  target.tx.transaction(() => {
    for (const batch of newBatches) target.batches.save(batch);
  });
  const batchScope = (id: string | null): DownloadScope | null =>
    id === null ? null : (batchRecords.get(id)?.scope ?? target.batches.get(id)?.scope ?? null);

  let position = target.downloads.nextPosition();
  let conversations = 0;
  let pausedDownloads = 0;
  let files = 0;
  let events = 0;
  let skipped = 0;
  for (const candidate of collectCandidates(input)) {
    const rawBatchId = candidate.job?.batchId ?? candidate.row?.batch_id ?? null;
    const scopeOfBatch = batchScope(rawBatchId);
    const batchId = scopeOfBatch === null ? null : rawBatchId;
    const scope: DownloadScope = candidate.job?.scope ?? scopeOfBatch ?? 'single';
    const context = { position, scope, batchId, titleFor: input.titleFor };
    const fromDatabase = candidate.row ? conversationToRecord(candidate.row, context) : null;
    const record = candidate.job
      ? jobToRecord(candidate.job, {
          ...context,
          now: input.now,
          cookieName: legacyCookieName(candidate.job.cookiesPath, input.cookieNames),
          fromDatabase
        })
      : fromDatabase;
    if (!record) continue;
    try {
      const written = target.tx.transaction(() => {
        target.downloads.save(record);
        let fileCount = 0;
        let eventCount = 0;
        if (candidate.row && input.reader) {
          for (const row of input.reader.files(candidate.id)) {
            const file = fileToMediaFile(row, candidate.id);
            if (file && target.files.add(file)) fileCount += 1;
          }
          for (const row of input.reader.events(candidate.id)) {
            target.events.appendLegacy(eventToLegacyEvent(row, candidate.id));
            eventCount += 1;
          }
        }
        return { fileCount, eventCount };
      });
      position += 1;
      conversations += 1;
      if (record.status === 'paused') pausedDownloads += 1;
      files += written.fileCount;
      events += written.eventCount;
    } catch (error) {
      skipped += 1;
      logger.warn('legacy conversation skipped', { id: candidate.id, error: describeError(error) });
    }
  }
  return { conversations, pausedDownloads, batches: newBatches.length, files, events, skipped };
}
