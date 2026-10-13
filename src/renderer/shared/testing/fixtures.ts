/** DTO builders for unit tests. */
import type {
  ConversationDetailDto,
  ConversationSummaryDto,
  DownloadProgressDto,
  HostStateDto,
  MediaFileDto
} from '../../../shared/contracts/dto.ts';
import { mediaTypeOf } from '../../../shared/domain/media.ts';

export function summary(id: string, patch: Partial<ConversationSummaryDto> = {}): ConversationSummaryDto {
  return {
    id,
    batchId: null,
    sourceUrl: `https://example.com/${id}`,
    title: `Conversation ${id}`,
    engine: 'gallery-dl',
    scope: 'single',
    status: 'completed',
    outcome: null,
    legacySummary: null,
    counters: { done: 0, skipped: 0, errors: 0 },
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
    coverPath: null,
    primaryMediaType: null,
    totalBytes: 0,
    folderId: null,
    ...patch
  };
}

export function detail(id: string, patch: Partial<ConversationDetailDto> = {}): ConversationDetailDto {
  return { ...summary(id), events: [], filesCount: 0, ...patch };
}

export function mediaFile(id: number, path: string, conversationId: string | null = 'c1'): MediaFileDto {
  const name = path.split('/').pop() ?? path;
  return { id, conversationId, path, name, mediaType: mediaTypeOf(name), extension: '', sizeBytes: 10, createdAt: id };
}

export function progress(conversationId: string, patch: Partial<DownloadProgressDto> = {}): DownloadProgressDto {
  return {
    conversationId,
    batchId: null,
    engine: 'yt-dlp',
    scope: 'single',
    sourceUrl: 'https://example.com',
    status: 'running',
    counters: { done: 1, skipped: 0, errors: 0 },
    percent: 42,
    speed: '1MiB/s',
    eta: '00:10',
    currentFile: '/dl/a.mp4',
    startedAt: 1,
    ...patch
  };
}

export function hostState(patch: Partial<HostStateDto['downloads']> = {}): HostStateDto {
  return {
    status: 'running',
    downloads: { active: [], queued: [], batch: null, ...patch },
    engines: {
      'gallery-dl': { engine: 'gallery-dl', available: true, version: '1', source: 'managed' },
      'yt-dlp': { engine: 'yt-dlp', available: false, version: null, source: 'none' }
    },
    config: {
      defaultEngine: 'gallery-dl',
      downloadDir: '/dl',
      cookies: { active: null, fromBrowser: false },
      accounts: {
        pixiv: { connected: false, userName: null },
        sites: {
          deviantart: { connected: false, userName: null },
          flickr: { connected: false, userName: null },
          pixiv: { connected: false, userName: null },
          reddit: { connected: false, userName: null },
          smugmug: { connected: false, userName: null },
          tumblr: { connected: false, userName: null },
          'mastodon.social': { connected: false, userName: null },
          pawoo: { connected: false, userName: null },
          baraag: { connected: false, userName: null }
        }
      },
      vault: { state: 'ready' }
    },
    runtime: {
      mode: 'standalone',
      setupNeeded: false,
      setupDismissed: false,
      busy: false,
      operation: null,
      updatesCheckedAt: null,
      tools: [],
      integrityPinned: true
    },
    lastError: null
  };
}
