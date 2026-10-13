/**
 * Public surface of the downloads core (implemented by `DownloadCoordinator`).
 * Other application services (session state, conversations, library) depend on
 * this interface, never on the coordinator class.
 */
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import type { DownloadScope, Engine } from '../../../shared/domain/engine.ts';
import type {
  BatchProgressDto,
  DownloadProgressDto,
  HostStatus,
  QueuedDownloadDto
} from '../../../shared/contracts/dto.ts';

export interface StartDownloadsInput {
  readonly urls: readonly string[];
  readonly engine: Engine;
  readonly scope: DownloadScope;
  /** Explicit cookie file per URL (same length as `urls`); `null` = automatic. */
  readonly cookieNames: readonly (string | null)[] | null;
  readonly folderId: string | null;
}

export interface StartDownloadsOutput {
  readonly batchId: string;
  readonly conversationIds: readonly string[];
}

export interface DownloadsSnapshot {
  readonly status: HostStatus;
  readonly active: readonly DownloadProgressDto[];
  readonly queued: readonly QueuedDownloadDto[];
  readonly batch: BatchProgressDto | null;
}

export type ShutdownMode = 'pause' | 'detach';

export type CommandOutcome = Result<{ readonly conversationId: string }, AppErrorData>;

export interface DownloadsFacade {
  /** Loads active downloads, re-attaches to live engine processes, finalizes dead ones, starts scheduling. */
  initialize(): Promise<void>;
  start(input: StartDownloadsInput): Promise<Result<StartDownloadsOutput, AppErrorData>>;
  pause(conversationId: string): Promise<CommandOutcome>;
  resume(conversationId: string): Promise<CommandOutcome>;
  stop(conversationId: string): Promise<CommandOutcome>;
  restart(conversationId: string): Promise<CommandOutcome>;
  pauseAll(): Promise<{ readonly affected: number }>;
  resumeAll(): Promise<{ readonly affected: number }>;
  stopAll(): Promise<{ readonly affected: number }>;
  /**
   * Stops the download if active and forgets it (in-memory supervision, job log,
   * workspace). Persistence rows are removed by the caller (delete use case).
   */
  forget(conversationId: string): Promise<Result<void, AppErrorData>>;
  snapshot(): DownloadsSnapshot;
  hasActive(): boolean;
  /** Registers a listener invoked whenever `snapshot()` may have changed (throttling is done by the caller). */
  onChange(listener: () => void): () => void;
  /**
   * `pause` (app quit): stop running engines in parallel (bounded deadline) and put them back
   * in the queue at their original position — they continue on the next launch; user-paused
   * downloads stay paused. `detach`: leave engines running for re-attach by the next host.
   */
  shutdown(mode: ShutdownMode): Promise<void>;
}
