/**
 * Batch aggregate (one batch per multi-URL `start` request).
 *
 * - The snapshot shows the NEWEST batch that still has an active download.
 * - A batch is finished once every remaining member is terminal; members deleted
 *   meanwhile no longer block it (legacy required `jobs.length >= total`).
 * - The batch notification is announced once (`notifiedAt`) and only for batches
 *   created with more than one URL — single downloads are announced individually.
 */
import {
  isActiveStatus,
  isTerminalStatus,
  type BatchFinished,
  type BatchProgress,
  type DownloadCounters,
  type DownloadStatus
} from '../../../shared/domain/download.ts';
import type { Engine } from '../../../shared/domain/engine.ts';

export interface BatchInfo {
  readonly id: string;
  readonly engine: Engine;
  /** Number of URLs the batch was created with. */
  readonly total: number;
  readonly createdAt: number;
  readonly notifiedAt: number | null;
}

export interface BatchMember {
  readonly id: string;
  readonly status: DownloadStatus;
  readonly counters: DownloadCounters;
}

/** Immutable batch aggregate: identity + current member snapshots. */
export class Batch {
  readonly info: BatchInfo;
  readonly members: readonly BatchMember[];

  constructor(info: BatchInfo, members: readonly BatchMember[]) {
    this.info = info;
    this.members = members;
  }

  hasActiveMember(): boolean {
    return this.members.some((member) => isActiveStatus(member.status));
  }

  isFinished(): boolean {
    return this.members.length > 0 && this.members.every((member) => isTerminalStatus(member.status));
  }

  /** Whether a finished batch deserves its own notification (multi-URL batches only). */
  shouldAnnounce(): boolean {
    return this.info.total > 1;
  }

  progress(): BatchProgress {
    let done = 0;
    let skipped = 0;
    let errors = 0;
    let finished = 0;
    for (const member of this.members) {
      done += member.counters.done;
      skipped += member.counters.skipped;
      errors += member.counters.errors;
      if (isTerminalStatus(member.status)) finished += 1;
    }
    return {
      batchId: this.info.id,
      engine: this.info.engine,
      total: this.members.length,
      finished,
      counters: { done, skipped, errors }
    };
  }

  /** Summary for `batch.finished`, or `null` when not finished or already notified. */
  finishedSummary(): BatchFinished | null {
    if (this.info.notifiedAt !== null || !this.isFinished()) return null;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    for (const member of this.members) {
      if (member.status === 'completed') completed += 1;
      else if (member.status === 'failed') failed += 1;
      else if (member.status === 'cancelled') cancelled += 1;
    }
    return {
      batchId: this.info.id,
      engine: this.info.engine,
      total: this.members.length,
      completed,
      failed,
      cancelled
    };
  }

  /** Aggregate of the newest batch (by creation time, then id) with an active member. */
  static displayed(batches: readonly Batch[]): BatchProgress | null {
    let newest: Batch | null = null;
    for (const batch of batches) {
      if (!batch.hasActiveMember()) continue;
      if (
        newest === null ||
        batch.info.createdAt > newest.info.createdAt ||
        (batch.info.createdAt === newest.info.createdAt && batch.info.id > newest.info.id)
      ) {
        newest = batch;
      }
    }
    return newest ? newest.progress() : null;
  }
}

export function isBatchFinished(members: readonly BatchMember[]): boolean {
  return members.length > 0 && members.every((member) => isTerminalStatus(member.status));
}
