/**
 * Tracks batches that still have active downloads, for the snapshot aggregate and
 * for the one-time `batch.finished` notification.
 */
import type { BatchFinished } from '../../../shared/domain/download.ts';
import { Batch, isBatchFinished, type BatchInfo, type BatchMember } from '../../domain/downloads/batch-progress.ts';
import type { BatchRecord, DownloadRecord, PersistenceContext } from '../ports/persistence.ts';
import type { DownloadRegistry } from './download-registry.ts';

interface TrackedBatch {
  info: BatchInfo;
  readonly members: Map<string, BatchMember>;
}

function toInfo(record: BatchRecord): BatchInfo {
  return {
    id: record.id,
    engine: record.engine,
    total: record.total,
    createdAt: record.createdAt,
    notifiedAt: record.notifiedAt
  };
}

function toMember(record: Pick<DownloadRecord, 'id' | 'status' | 'counters'>): BatchMember {
  return { id: record.id, status: record.status, counters: record.counters };
}

export class BatchTracker {
  readonly #persistence: PersistenceContext;
  readonly #batches = new Map<string, TrackedBatch>();

  constructor(persistence: PersistenceContext) {
    this.#persistence = persistence;
  }

  /** Starts tracking a batch created now (members are all new). */
  add(record: BatchRecord, members: readonly BatchMember[]): void {
    this.#batches.set(record.id, { info: toInfo(record), members: new Map(members.map((m) => [m.id, m])) });
  }

  /** Starts tracking an existing batch (host restart, restart of a download). */
  track(batchId: string | null): void {
    if (batchId === null || this.#batches.has(batchId)) return;
    const record = this.#persistence.batches.get(batchId);
    if (!record) return;
    const members = this.#persistence.downloads.listByBatch(batchId).map(toMember);
    this.add(record, members);
  }

  /** Updates the stored member snapshot (used once a download leaves the registry). */
  update(batchId: string | null, member: BatchMember): void {
    if (batchId === null) return;
    this.#batches.get(batchId)?.members.set(member.id, member);
  }

  removeMember(batchId: string | null, id: string): void {
    if (batchId === null) return;
    this.#batches.get(batchId)?.members.delete(id);
  }

  /** Live aggregates for downloads still in the registry. */
  batches(registry: DownloadRegistry): Batch[] {
    return [...this.#batches.values()].map(
      (tracked) =>
        new Batch(
          tracked.info,
          [...tracked.members.values()].map((member) => {
            const live = registry.get(member.id);
            return live ? { id: member.id, status: live.status, counters: live.counters } : member;
          })
        )
    );
  }

  /**
   * When every remaining member of the batch is terminal (read from persistence,
   * so deleted conversations do not block it): marks it notified once and returns
   * the summary to announce (multi-URL batches only). `excludeIds` are members
   * being forgotten whose rows are about to be deleted.
   */
  settle(batchId: string | null, now: number, excludeIds: ReadonlySet<string> = new Set()): BatchFinished | null {
    if (batchId === null) return null;
    const record = this.#persistence.batches.get(batchId);
    if (!record) {
      this.#batches.delete(batchId);
      return null;
    }
    const members = this.#persistence.downloads
      .listByBatch(batchId)
      .filter((member) => !excludeIds.has(member.id))
      .map(toMember);
    const batch = new Batch(toInfo(record), members);
    const summary = batch.finishedSummary();
    if (!summary) {
      // Already notified (e.g. a restarted member finished) or nothing left: stop tracking.
      if (members.length === 0 || isBatchFinished(members)) this.#batches.delete(batchId);
      return null;
    }
    this.#persistence.batches.save({ ...record, notifiedAt: now });
    this.#batches.delete(batchId);
    return batch.shouldAnnounce() ? summary : null;
  }
}
