/**
 * Pure selectors for conversations: status predicates, live progress per
 * conversation (from `state.downloads`) and folder grouping for the sidebar.
 */
import type {
  ConversationSummaryDto,
  DownloadStatus,
  FolderDto,
  HostStateDto,
  MediaFileDto
} from '../../../../shared/contracts/dto.ts';
import type { MediaType } from '../../../../shared/domain/media.ts';

/** Queued or downloading. */
export function isWorkingStatus(status: DownloadStatus): boolean {
  return status === 'running' || status === 'pending';
}

/** Can be restarted from scratch (engines skip what already exists). */
export function isRestartableStatus(status: DownloadStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Live progress of one conversation as a FLAT record of primitives, so React
 * selectors can compare it shallowly and skip renders when another
 * conversation's progress changed (host snapshots arrive up to 4×/s).
 */
export interface LiveProgress {
  readonly kind: 'running' | 'queued';
  readonly status: DownloadStatus;
  /** 1-based queue position; `0` while running. */
  readonly position: number;
  readonly done: number;
  readonly skipped: number;
  readonly errors: number;
  readonly percent: number | null;
  readonly speed: string | null;
  readonly eta: string | null;
  readonly currentFile: string | null;
}

/**
 * Progress of ONE conversation, looked up by id in the host snapshot (the legacy
 * UI showed the global batch stats on every card).
 */
export function liveProgressOf(state: HostStateDto | null, conversationId: string | null): LiveProgress | null {
  if (!state || !conversationId) return null;
  const active = state.downloads.active.find((item) => item.conversationId === conversationId);
  if (active) {
    return {
      kind: 'running',
      status: active.status,
      position: 0,
      done: active.counters.done,
      skipped: active.counters.skipped,
      errors: active.counters.errors,
      percent: active.percent,
      speed: active.speed,
      eta: active.eta,
      currentFile: active.currentFile
    };
  }
  const index = state.downloads.queued.findIndex((item) => item.conversationId === conversationId);
  const queued = state.downloads.queued[index];
  if (!queued) return null;
  return {
    kind: 'queued',
    status: queued.status,
    position: index + 1,
    done: 0,
    skipped: 0,
    errors: 0,
    percent: null,
    speed: null,
    eta: null,
    currentFile: null
  };
}

/** The freshest status: live snapshot first, persisted summary otherwise. */
export function effectiveStatus(summaryStatus: DownloadStatus, live: LiveProgress | null): DownloadStatus {
  return live ? live.status : summaryStatus;
}

export interface FolderGroups {
  readonly unfiled: readonly ConversationSummaryDto[];
  readonly byFolder: ReadonlyMap<string, readonly ConversationSummaryDto[]>;
}

/** O(n) grouping; conversations whose folder no longer exists are unfiled. */
export function groupByFolder(
  conversations: readonly ConversationSummaryDto[],
  folders: readonly FolderDto[]
): FolderGroups {
  const byFolder = new Map<string, ConversationSummaryDto[]>();
  for (const folder of folders) byFolder.set(folder.id, []);
  const unfiled: ConversationSummaryDto[] = [];
  for (const conversation of conversations) {
    const bucket = conversation.folderId ? byFolder.get(conversation.folderId) : undefined;
    if (bucket) bucket.push(conversation);
    else unfiled.push(conversation);
  }
  return { unfiled, byFolder };
}

/** Visual media first (images/videos) for the preview mosaic. */
export function mosaicFiles(files: readonly MediaFileDto[], limit: number): readonly MediaFileDto[] {
  const visual = files.filter((file) => file.mediaType === 'image' || file.mediaType === 'video');
  return (visual.length > 0 ? visual : files).slice(0, limit);
}

export type CountNoun = 'image' | 'video' | 'audio' | 'file';

export function countNounFor(mediaType: MediaType | null): CountNoun {
  if (mediaType === 'image' || mediaType === 'video' || mediaType === 'audio') return mediaType;
  return 'file';
}
