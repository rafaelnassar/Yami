/**
 * Builds the cheap, synchronous `DownloadsSnapshot` from memory. Progress is PER
 * download (the legacy card showed the global stats of whatever job ran last).
 */
import type { DownloadProgressDto, HostStatus, QueuedDownloadDto } from '../../../shared/contracts/dto.ts';
import { Batch } from '../../domain/downloads/batch-progress.ts';
import type { Download } from '../../domain/downloads/download.ts';
import type { BatchTracker } from './batch-tracker.ts';
import type { DownloadsSnapshot } from './downloads-facade.ts';
import type { DownloadRegistry } from './download-registry.ts';

function progressOf(download: Download): DownloadProgressDto {
  const { percent, speed, eta, currentFile } = download.progress;
  return {
    conversationId: download.id,
    batchId: download.batchId,
    engine: download.engine,
    scope: download.scope,
    sourceUrl: download.sourceUrl,
    status: download.status,
    counters: download.counters,
    percent,
    speed,
    eta,
    currentFile,
    startedAt: download.startedAt
  };
}

function queuedOf(download: Download, status: 'pending' | 'paused'): QueuedDownloadDto {
  return {
    conversationId: download.id,
    sourceUrl: download.sourceUrl,
    engine: download.engine,
    scope: download.scope,
    status
  };
}

export function buildSnapshot(registry: DownloadRegistry, batches: BatchTracker): DownloadsSnapshot {
  const active: DownloadProgressDto[] = [];
  const queued: QueuedDownloadDto[] = [];
  let hasPaused = false;
  for (const download of registry.all()) {
    if (download.status === 'running') active.push(progressOf(download));
    else if (download.status === 'pending' || download.status === 'paused') {
      queued.push(queuedOf(download, download.status));
      hasPaused ||= download.status === 'paused';
    }
  }
  const working = active.length > 0 || queued.some((item) => item.status === 'pending');
  const status: HostStatus = working ? 'running' : hasPaused ? 'paused' : 'idle';
  return { status, active, queued, batch: Batch.displayed(batches.batches(registry)) };
}
