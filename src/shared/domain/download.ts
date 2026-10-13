/**
 * Download lifecycle concepts shared by every process.
 *
 * Owned by the domain model (not by IPC contracts). `shared/contracts/dto.ts`
 * re-exports DTO aliases so protocol/UI layers keep a stable import path.
 */
import type { Engine } from './engine.ts';

export const DOWNLOAD_STATUSES = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number];

export const ACTIVE_DOWNLOAD_STATUSES: readonly DownloadStatus[] = ['pending', 'running', 'paused'];
export const TERMINAL_DOWNLOAD_STATUSES: readonly DownloadStatus[] = ['completed', 'failed', 'cancelled'];

export function isActiveStatus(status: DownloadStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

export function isTerminalStatus(status: DownloadStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Structured result of a finished download.
 * - `ok`: every item downloaded or skipped without errors.
 * - `partial`: at least one item downloaded/skipped, but errors were reported.
 * - `empty`: the engine finished without downloading or skipping anything.
 * - `error`: the engine failed before producing anything.
 * - `cancelled`: stopped by the user.
 */
export type OutcomeKind = 'ok' | 'partial' | 'empty' | 'error' | 'cancelled';

export interface DownloadOutcome {
  readonly kind: OutcomeKind;
  /** Stable reason code when known (e.g. `engine-missing`, `spawn-failed`, `pixiv-auth`). */
  readonly reason: string | null;
  /** Last engine error line (raw engine text, redacted), when any. */
  readonly detail: string | null;
}

export interface DownloadCounters {
  readonly done: number;
  readonly skipped: number;
  readonly errors: number;
}

export const EMPTY_DOWNLOAD_COUNTERS: DownloadCounters = { done: 0, skipped: 0, errors: 0 };

/** Aggregate progress of a multi-URL batch that still has active members. */
export interface BatchProgress {
  readonly batchId: string;
  readonly engine: Engine;
  readonly total: number;
  readonly finished: number;
  readonly counters: DownloadCounters;
}

/** One-shot summary emitted when every remaining batch member is terminal. */
export interface BatchFinished {
  readonly batchId: string;
  readonly engine: Engine;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}
