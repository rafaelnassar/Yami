/** Test-only helpers for the persistence adapter (temp dirs and record builders). */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BatchRecord, DownloadRecord, NewMediaFile } from '../../application/ports/persistence.ts';
import type { Logger, LogFields } from '../../application/ports/system.ts';
import { createSqlitePersistence, type SqlitePersistence } from './sqlite-persistence.ts';

export function makeTempDir(prefix = 'yami-db-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

export function captureLogger(): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const logger: Logger = {
    debug: (message, fields) => entries.push({ level: 'debug', message, fields }),
    info: (message, fields) => entries.push({ level: 'info', message, fields }),
    warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
    error: (message, fields) => entries.push({ level: 'error', message, fields }),
    child: () => logger
  };
  return { logger, entries };
}

export function openTestPersistence(
  dir: string,
  platform: 'linux' | 'win32' | 'darwin' = 'linux',
  logger?: Logger
): SqlitePersistence {
  return createSqlitePersistence({ dataDir: dir, platform, ...(logger ? { logger } : {}) });
}

export function downloadRecord(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'd1',
    batchId: null,
    sourceUrl: 'https://example.com/gallery/1',
    title: '1',
    engine: 'gallery-dl',
    scope: 'single',
    status: 'completed',
    outcome: { kind: 'ok', reason: null, detail: null },
    legacySummary: null,
    counters: { done: 1, skipped: 0, errors: 0 },
    cookieName: null,
    folderId: null,
    position: 0,
    createdAt: 1_000,
    startedAt: 1_100,
    completedAt: 1_200,
    updatedAt: 1_200,
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

export function batchRecord(overrides: Partial<BatchRecord> = {}): BatchRecord {
  return { id: 'b1', engine: 'gallery-dl', scope: 'bulk', total: 2, createdAt: 1_000, notifiedAt: null, ...overrides };
}

export function mediaFile(overrides: Partial<NewMediaFile> = {}): NewMediaFile {
  return {
    conversationId: 'd1',
    path: '/dl/gallery-dl/a.jpg',
    name: 'a.jpg',
    mediaType: 'image',
    extension: '.jpg',
    sizeBytes: 100,
    createdAt: 2_000,
    ...overrides
  };
}
