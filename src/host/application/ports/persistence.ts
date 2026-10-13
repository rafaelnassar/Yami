/**
 * Persistence ports (implemented by `host/infrastructure/persistence/sqlite`).
 *
 * Write side: repositories load/save plain *records*; domain entities map to and
 * from records (`Download.fromRecord` / `download.toRecord()`).
 * Read side: query ports return DTOs directly (CQRS-lite), so list screens never
 * hydrate entities.
 *
 * All methods are synchronous (SQLite via `node:sqlite`) and must be called
 * inside `TransactionRunner.transaction` when several writes must be atomic.
 */
import type { DownloadCounters, DownloadOutcome, DownloadStatus } from '../../../shared/domain/download.ts';
import type { DownloadScope, Engine, RuntimeMode, ToolId } from '../../../shared/domain/engine.ts';
import type { MediaType } from '../../../shared/domain/media.ts';
import type {
  ConversationDetailDto,
  ConversationEventDto,
  ConversationEventType,
  ConversationSummaryDto,
  CookieBindingDto,
  EventLevel,
  FolderDto,
  MediaFileDto,
  Page,
  Params
} from '../../../shared/contracts/dto.ts';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import type { EngineErrorKind } from '../../domain/engines/parsed-line.ts';

/* ─────────────────────────── Records ─────────────────────────── */

export type BrowserCookieMode = 'skip' | 'force' | null;

export interface DownloadRetryState {
  /** yt-dlp only: override of browser-cookie usage for the next run. */
  readonly browserCookieMode: BrowserCookieMode;
  readonly skipTried: boolean;
  readonly forceTried: boolean;
}

/** Persisted state of one download (= one conversation in the UI). */
export interface DownloadRecord {
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
  /** Cookie file explicitly chosen for this download (`null` = automatic resolution). */
  readonly cookieName: string | null;
  readonly folderId: string | null;
  /** Monotonic scheduling order (lower runs first). */
  readonly position: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly updatedAt: number;
  /* Runtime bookkeeping, persisted so a restarted host can re-attach. */
  readonly process: ProcessIdentity | null;
  readonly logFile: string | null;
  readonly logOffset: number;
  readonly retry: DownloadRetryState;
  readonly usedBrowserCookies: boolean;
  readonly lastErrorKind: EngineErrorKind | null;
  /** Last ≤ 10 engine error messages (redacted). */
  readonly errorLines: readonly string[];
}

export interface BatchRecord {
  readonly id: string;
  readonly engine: Engine;
  readonly scope: DownloadScope;
  readonly total: number;
  readonly createdAt: number;
  /** Set once the batch-finished notification was emitted. */
  readonly notifiedAt: number | null;
}

export interface NewMediaFile {
  readonly conversationId: string | null;
  readonly path: string;
  readonly name: string;
  readonly mediaType: MediaType;
  readonly extension: string;
  readonly sizeBytes: number | null;
  readonly createdAt: number;
}

export interface NewConversationEvent {
  readonly conversationId: string;
  readonly type: ConversationEventType;
  readonly level: EventLevel;
  /** i18n key suffix under `conversationEvents.` */
  readonly code: string;
  readonly params: Params;
  readonly createdAt: number;
}

export interface HostSettings {
  /** `null` until configured; the application falls back to the OS default. */
  readonly downloadDir: string | null;
  readonly defaultEngine: Engine;
  readonly runtimeMode: RuntimeMode;
  readonly setupDismissed: boolean;
  readonly cookies: {
    readonly active: string | null;
    readonly fromBrowser: boolean;
    readonly bindings: readonly CookieBindingDto[];
  };
  readonly toolUpdates: {
    readonly checkedAt: number | null;
    readonly latest: Readonly<Partial<Record<ToolId, string>>>;
  };
}

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  downloadDir: null,
  defaultEngine: 'gallery-dl',
  runtimeMode: 'standalone',
  setupDismissed: false,
  cookies: { active: null, fromBrowser: false, bindings: [] },
  toolUpdates: { checkedAt: null, latest: {} }
};

/* ─────────────────────────── Repositories (write side) ─────────────────────────── */

/**
 * Ownership of columns: `title` (conversations.rename) and `folderId` (FolderRepository.assign)
 * are owned by their use cases. `save` must never overwrite `folder_id` of an existing row, and
 * the downloads core re-reads `title`/`folderId`/`legacySummary` before saving.
 */
export interface DownloadRepository {
  get(id: string): DownloadRecord | null;
  /** pending | running | paused, ordered by `position`. */
  listActive(): DownloadRecord[];
  save(record: DownloadRecord): void;
  delete(id: string): void;
  /** Next free scheduling position. */
  nextPosition(): number;
  /** Most recent distinct source URLs (for the clipboard suggestion feature). */
  recentSourceUrls(limit: number): string[];
  /** Downloads of a batch (any status). */
  listByBatch(batchId: string): DownloadRecord[];
}

export interface BatchRepository {
  get(id: string): BatchRecord | null;
  save(record: BatchRecord): void;
}

export interface MediaFileRepository {
  /** Inserts the file; returns `null` when `(conversationId, path)` already exists. */
  add(file: NewMediaFile): MediaFileDto | null;
  listByConversation(conversationId: string, limit: number, cursor: string | null): Page<MediaFileDto>;
  countByConversation(conversationId: string): number;
  pathsByConversation(conversationId: string): string[];
  deleteByConversation(conversationId: string): number;
  deleteByPaths(paths: readonly string[]): number;
  /**
   * Rewrites stored paths under `oldDir` to `newDir` (exact directory match:
   * `oldDir` itself or `oldDir + separator + …`, never sibling prefixes).
   * `caseInsensitive` must be true on Windows.
   */
  renameDirectory(oldDir: string, newDir: string, caseInsensitive: boolean): number;
  /** conversationId for each known path (library enrichment). */
  conversationIdsForPaths(paths: readonly string[]): Map<string, string>;
  /**
   * The subset of `paths` (as given) that a conversation other than `conversationId`
   * still records (e.g. a re-download of the same file). Paths match like
   * `deleteByPaths`: exactly, ignoring case on Windows.
   */
  pathsReferencedElsewhere(paths: readonly string[], conversationId: string): string[];
}

export interface ConversationEventRepository {
  append(event: NewConversationEvent): void;
  deleteByConversation(conversationId: string): void;
}

export interface FolderRepository {
  list(): FolderDto[];
  get(id: string): FolderDto | null;
  save(folder: FolderDto): void;
  delete(id: string): void;
  /** Assigns (or clears with `null`) the folder of the given conversations. Returns rows changed. */
  assign(conversationIds: readonly string[], folderId: string | null): number;
  /** Clears the folder of every conversation in `folderId`. */
  unassignAll(folderId: string): void;
  nextPosition(): number;
}

export interface HostSettingsRepository {
  load(): HostSettings;
  save(settings: HostSettings): void;
}

/* ─────────────────────────── Queries (read side) ─────────────────────────── */

export interface ConversationQueries {
  /** Newest first (`updatedAt DESC, id DESC`). Cursor is opaque. */
  list(limit: number, cursor: string | null): Page<ConversationSummaryDto>;
  get(id: string): ConversationDetailDto | null;
  /** The newest `limit` events, returned oldest first. */
  recentEvents(conversationId: string, limit: number): ConversationEventDto[];
}

/* ─────────────────────────── Transactions ─────────────────────────── */

export interface TransactionRunner {
  /** Runs `work` atomically (nested calls join the outer transaction). */
  transaction<T>(work: () => T): T;
}

/** Everything the persistence adapter provides, created once by the composition root. */
export interface PersistenceContext {
  readonly downloads: DownloadRepository;
  readonly batches: BatchRepository;
  readonly files: MediaFileRepository;
  readonly events: ConversationEventRepository;
  readonly folders: FolderRepository;
  readonly settings: HostSettingsRepository;
  readonly conversations: ConversationQueries;
  readonly tx: TransactionRunner;
  close(): void;
}
