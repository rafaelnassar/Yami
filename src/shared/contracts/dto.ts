/**
 * Data Transfer Objects exchanged between host, main and renderer.
 *
 * Rules:
 * - Plain, serializable data only (structured-clone safe). No classes, no functions.
 * - No user-facing text: anything shown to the user travels as a `code` + `params`
 *   and is localized by the renderer (see `src/shared/i18n`). Raw engine output
 *   (log lines, engine error details) is passed through as `detail` params.
 */
import type { AppErrorData } from '../kernel/errors.ts';
import type {
  BatchFinished,
  BatchProgress,
  DownloadCounters,
  DownloadOutcome,
  DownloadStatus
} from '../domain/download.ts';
import type { DownloadScope, Engine, RuntimeMode, ToolId } from '../domain/engine.ts';
import type { Folder } from '../domain/folder.ts';
import type { LogLevel } from '../domain/log.ts';
import type { FileRisk, MediaType } from '../domain/media.ts';
import type { EngineInfo, ToolStatus } from '../domain/runtime.ts';

export type ParamValue = string | number | boolean | null;
export type Params = Readonly<Record<string, ParamValue>>;

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page, or `null` when this is the last page. */
  readonly nextCursor: string | null;
}

/* ─────────────────────────── Downloads (domain types, DTO aliases) ─────────────────────────── */

export {
  ACTIVE_DOWNLOAD_STATUSES,
  DOWNLOAD_STATUSES,
  TERMINAL_DOWNLOAD_STATUSES,
  isActiveStatus,
  isTerminalStatus,
  type DownloadStatus,
  type OutcomeKind
} from '../domain/download.ts';

/** IPC alias — same shape as the domain `DownloadOutcome`. */
export type DownloadOutcomeDto = DownloadOutcome;
/** IPC alias — same shape as the domain `DownloadCounters`. */
export type DownloadCountersDto = DownloadCounters;

/** Live progress of one download (one conversation) — sent inside `HostStateDto`. */
export interface DownloadProgressDto {
  readonly conversationId: string;
  readonly batchId: string | null;
  readonly engine: Engine;
  readonly scope: DownloadScope;
  readonly sourceUrl: string;
  readonly status: DownloadStatus;
  readonly counters: DownloadCountersDto;
  /** 0–100 of the current file (yt-dlp only), `null` when unknown. */
  readonly percent: number | null;
  readonly speed: string | null;
  readonly eta: string | null;
  readonly currentFile: string | null;
  readonly startedAt: number | null;
}

/** IPC alias — same shape as the domain `BatchProgress`. */
export type BatchProgressDto = BatchProgress;

export interface ConversationSummaryDto {
  readonly id: string;
  readonly batchId: string | null;
  readonly sourceUrl: string;
  readonly title: string;
  readonly engine: Engine;
  readonly scope: DownloadScope;
  readonly status: DownloadStatus;
  readonly outcome: DownloadOutcomeDto | null;
  /** Free text kept only for rows migrated from the legacy database. */
  readonly legacySummary: string | null;
  readonly counters: DownloadCountersDto;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly updatedAt: number;
  readonly coverPath: string | null;
  readonly primaryMediaType: MediaType | null;
  readonly totalBytes: number;
  readonly folderId: string | null;
}

export const CONVERSATION_EVENT_TYPES = [
  'created',
  'started',
  'paused',
  'resumed',
  'cancelled',
  'restarted',
  'retry',
  'completed',
  'failed',
  'legacy'
] as const;
export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

export type EventLevel = 'info' | 'success' | 'warning' | 'error';

export interface ConversationEventDto {
  readonly id: number;
  readonly conversationId: string;
  readonly type: ConversationEventType;
  readonly level: EventLevel;
  /** i18n key suffix under `conversationEvents.` (e.g. `started`, `retryWithoutCookies`). */
  readonly code: string;
  readonly params: Params;
  /** Legacy free text (only for events migrated from the old database). */
  readonly legacyMessage: string | null;
  readonly createdAt: number;
}

export interface ConversationDetailDto extends ConversationSummaryDto {
  /** Most recent events (max 300), oldest first. */
  readonly events: readonly ConversationEventDto[];
  readonly filesCount: number;
}

export interface MediaFileDto {
  readonly id: number;
  readonly conversationId: string | null;
  readonly path: string;
  readonly name: string;
  readonly mediaType: MediaType;
  readonly extension: string;
  readonly sizeBytes: number | null;
  readonly createdAt: number;
}

/* ─────────────────────────── Folders (sidebar organization) ─────────────────────────── */

/** IPC alias — same shape as the domain `Folder`. */
export type FolderDto = Folder;

export interface FileInspectionDto {
  /** Canonical (real) path inside the download directory. */
  readonly path: string;
  readonly name: string;
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly sizeBytes: number | null;
  readonly mediaType: MediaType;
  /** MIME for previewable media, `null` otherwise. */
  readonly previewMime: string | null;
  readonly risk: FileRisk;
}

/* ─────────────────────────── Cookies & accounts ─────────────────────────── */

export interface CookieFileDto {
  readonly name: string;
  readonly sizeBytes: number;
  readonly updatedAt: number;
  /** Distinct domains found in the file (max 20), to help the user pick bindings. */
  readonly domains: readonly string[];
}

export interface CookieBindingDto {
  readonly id: string;
  /** Host without protocol, e.g. `danbooru.donmai.us`. Subdomains match. */
  readonly siteHost: string;
  readonly cookieName: string;
}

export interface AccountStatusDto {
  readonly connected: boolean;
  readonly userName: string | null;
}

export interface AccountsDto {
  /** Public status keyed by vault site id (never tokens). */
  readonly sites: Readonly<Record<string, AccountStatusDto>>;
  /** Derived from `sites.pixiv` for backward compatibility. */
  readonly pixiv: AccountStatusDto;
}

/**
 * Why main could not load the vault data key: `keystore` — the OS keystore is missing or
 * refused to decrypt it (e.g. DPAPI after a Windows password reset, Linux keyring gone);
 * `corrupted` — `key.bin` is truncated or unknown; `io` — it could not be read/written.
 */
export const VAULT_UNAVAILABLE_REASONS = ['keystore', 'corrupted', 'io'] as const;
export type VaultUnavailableReason = (typeof VAULT_UNAVAILABLE_REASONS)[number];

/**
 * Secret vault (cookie files, Pixiv login). `disabled`: the host runs without it —
 * downloads, history and library work; cookie and Pixiv operations fail with
 * `VAULT_UNAVAILABLE` until the vault is reset (`YamiApi.vault.reset`) or the key loads again.
 */
export type VaultStatusDto =
  { readonly state: 'ready' } | { readonly state: 'disabled'; readonly reason: VaultUnavailableReason };

/* ─────────────────────────── Runtime tools ─────────────────────────── */

/** IPC alias — same shape as the domain `ToolStatus`. */
export type ToolStatusDto = ToolStatus;
/** IPC alias — same shape as the domain `EngineInfo`. */
export type EngineInfoDto = EngineInfo;

export interface RuntimeStatusDto {
  readonly mode: RuntimeMode;
  readonly setupNeeded: boolean;
  readonly setupDismissed: boolean;
  /** An install/update/check operation is in flight. */
  readonly busy: boolean;
  readonly operation: RuntimeOperationDto | null;
  readonly updatesCheckedAt: number | null;
  readonly tools: readonly ToolStatusDto[];
  /**
   * False when the embedded runtime manifest has no pinned checksums — or, in python
   * mode, no hash lock of the pip packages for this platform (dev builds only).
   */
  readonly integrityPinned: boolean;
}

export type RuntimeOperationKind = 'install' | 'update' | 'check-updates';

export interface RuntimeOperationDto {
  readonly id: string;
  readonly kind: RuntimeOperationKind;
  readonly tools: readonly ToolId[];
  readonly startedAt: number;
}

export type RuntimeProgressPhase = 'start' | 'download' | 'verify' | 'extract' | 'install' | 'done' | 'error';

export interface RuntimeProgressDto {
  readonly operationId: string;
  readonly tool: ToolId | null;
  readonly phase: RuntimeProgressPhase;
  /** i18n key suffix under `runtimeProgress.` */
  readonly code: string;
  readonly params: Params;
  /** Overall percent 0–100 or `null` when indeterminate. */
  readonly percent: number | null;
  readonly step: number | null;
  readonly totalSteps: number | null;
  readonly ts: number;
}

/* ─────────────────────────── Notices & logs ─────────────────────────── */

export type NoticeKind = 'error' | 'warn' | 'success' | 'info';

export interface NoticeActionDto {
  readonly type: 'runtime-update';
  readonly tools: readonly ToolId[];
}

export interface NoticeDto {
  /** Stable id for de-duplication/dismissal (e.g. `runtime-updates`). */
  readonly id: string;
  readonly kind: NoticeKind;
  /** i18n key suffix under `notices.` — the UI renders `notices.<code>.title` / `.message`. */
  readonly code: string;
  readonly params: Params;
  readonly action: NoticeActionDto | null;
  readonly ts: number;
}

export type { LogLevel } from '../domain/log.ts';

export interface LogEntryDto {
  readonly ts: number;
  readonly level: LogLevel;
  /** Raw (redacted) engine output line, when the entry comes from an engine. */
  readonly text: string | null;
  /** i18n key suffix under `logs.` for host-generated entries. */
  readonly code: string | null;
  readonly params: Params;
  readonly conversationId: string | null;
}

/* ─────────────────────────── Host state snapshot ─────────────────────────── */

export type HostStatus = 'idle' | 'running' | 'paused';

export interface HostConfigDto {
  readonly defaultEngine: Engine;
  readonly downloadDir: string;
  readonly cookies: {
    readonly active: string | null;
    readonly fromBrowser: boolean;
  };
  readonly accounts: AccountsDto;
  readonly vault: VaultStatusDto;
}

export interface QueuedDownloadDto {
  readonly conversationId: string;
  readonly sourceUrl: string;
  readonly engine: Engine;
  readonly scope: DownloadScope;
  readonly status: 'pending' | 'paused';
}

export interface HostStateDto {
  readonly status: HostStatus;
  readonly downloads: {
    /** Running downloads with live progress. */
    readonly active: readonly DownloadProgressDto[];
    /** Pending and paused downloads, in scheduling order. */
    readonly queued: readonly QueuedDownloadDto[];
    /** Aggregate of the most recent batch that still has active downloads. */
    readonly batch: BatchProgressDto | null;
  };
  readonly engines: Readonly<Record<Engine, EngineInfoDto>>;
  readonly config: HostConfigDto;
  readonly runtime: RuntimeStatusDto;
  readonly lastError: NoticeDto | null;
}

/* ─────────────────────────── Completion events ─────────────────────────── */

export interface DownloadFinishedDto {
  readonly conversationId: string;
  readonly batchId: string | null;
  readonly sourceUrl: string;
  readonly title: string;
  readonly engine: Engine;
  readonly status: 'completed' | 'failed';
  readonly outcome: DownloadOutcomeDto;
  readonly counters: DownloadCountersDto;
  readonly completedAt: number;
}

/** IPC alias — same shape as the domain `BatchFinished`. */
export type BatchFinishedDto = BatchFinished;

export type ErrorDto = AppErrorData;
