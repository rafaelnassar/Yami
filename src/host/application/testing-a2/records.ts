/** Builders for persistence records and DTOs used across A2 tests. */
import type { ConversationDetailDto, FolderDto, NoticeDto } from '../../../shared/contracts/dto.ts';
import { DEFAULT_HOST_SETTINGS, type DownloadRecord, type HostSettings } from '../ports/persistence.ts';

export function makeDownloadRecord(overrides: Partial<DownloadRecord> & { readonly id: string }): DownloadRecord {
  return {
    batchId: null,
    sourceUrl: `https://example.com/${overrides.id}`,
    title: overrides.id,
    engine: 'gallery-dl',
    scope: 'single',
    status: 'completed',
    outcome: null,
    legacySummary: null,
    counters: { done: 0, skipped: 0, errors: 0 },
    cookieName: null,
    folderId: null,
    position: 0,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
    process: null,
    logFile: null,
    logOffset: 0,
    retry: { browserCookieMode: null, skipTried: false, forceTried: false },
    usedBrowserCookies: false,
    lastErrorKind: null,
    errorLines: [],
    ...overrides
  };
}

export function makeFolder(overrides: Partial<FolderDto> & { readonly id: string }): FolderDto {
  return { name: overrides.id, color: '#94A3B8', collapsed: false, position: 0, createdAt: 1, ...overrides };
}

export function makeSettings(overrides: Partial<HostSettings> = {}): HostSettings {
  return { ...DEFAULT_HOST_SETTINGS, ...overrides };
}

export function makeConversationDetail(id: string): ConversationDetailDto {
  return {
    id,
    batchId: null,
    sourceUrl: `https://example.com/${id}`,
    title: id,
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
    events: [],
    filesCount: 0
  };
}

export function makeNotice(overrides: Partial<NoticeDto> = {}): NoticeDto {
  return { id: 'n1', kind: 'error', code: 'downloadFailed', params: {}, action: null, ts: 1, ...overrides };
}
