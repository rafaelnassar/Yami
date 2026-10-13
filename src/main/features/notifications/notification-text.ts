/** Pure, localized text for OS notifications about finished downloads and batches. */
import type { BatchFinishedDto, DownloadFinishedDto } from '../../../shared/contracts/dto.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import type { Translator } from '../../../shared/i18n/translator.ts';
import { siteHostOf } from '../../../shared/domain/url.ts';

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
  readonly urgency: 'low' | 'normal' | 'critical';
  /** Stable key used for de-duplication and as the Windows toast tag. */
  readonly key: string;
  readonly groupId: string;
}

const SEPARATOR = ' · ';
const MAX_DETAIL = 96;

function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function siteLabel(download: DownloadFinishedDto): string {
  return siteHostOf(download.sourceUrl) || shorten(download.title || download.sourceUrl, 40);
}

export function downloadNotification(download: DownloadFinishedDto, t: Translator<MessageKey>): NotificationContent {
  const ok = download.status === 'completed';
  // Completed with errors, or the engine died mid-run (killed/crashed) after saving some files.
  const partial = ok && download.outcome.kind === 'partial';
  const site = siteLabel(download);
  const { done, skipped, errors } = download.counters;
  const parts: string[] = [];

  if (ok) {
    if (done > 0) parts.push(t.t('main.notify.download.files', { count: done }));
    if (skipped > 0) parts.push(t.t('main.notify.download.skipped', { count: skipped }));
    if (done === 0 && skipped === 0) parts.push(t.t('main.notify.download.nothingNew'));
    if (errors > 0) parts.push(t.t('main.notify.download.errors', { count: errors }));
    else if (partial) parts.push(t.t('main.notify.download.interrupted'));
  } else {
    const detail = download.outcome.detail ? shorten(download.outcome.detail, MAX_DETAIL) : '';
    parts.push(detail || t.t('main.notify.download.seeDetails'));
  }
  parts.push(download.engine);

  return {
    title: t.t(
      partial ? 'main.notify.download.partial' : ok ? 'main.notify.download.completed' : 'main.notify.download.failed',
      { site }
    ),
    body: parts.join(SEPARATOR),
    silent: ok && !partial,
    urgency: partial ? 'normal' : ok ? 'low' : 'critical',
    key: `download:${download.conversationId}:${download.status}`,
    groupId: 'yami.downloads'
  };
}

export function batchNotification(batch: BatchFinishedDto, t: Translator<MessageKey>): NotificationContent {
  const titleKey =
    batch.failed > 0
      ? 'main.notify.batch.failed'
      : batch.cancelled > 0
        ? 'main.notify.batch.cancelled'
        : 'main.notify.batch.completed';
  const parts = [t.t('main.notify.batch.progress', { completed: batch.completed, total: batch.total })];
  if (batch.failed > 0) parts.push(t.t('main.notify.batch.failedCount', { count: batch.failed }));
  if (batch.cancelled > 0) parts.push(t.t('main.notify.batch.cancelledCount', { count: batch.cancelled }));
  parts.push(batch.engine);

  const status = batch.failed > 0 ? 'failed' : batch.cancelled > 0 ? 'cancelled' : 'completed';
  return {
    title: t.t(titleKey),
    body: parts.join(SEPARATOR),
    silent: batch.failed === 0,
    urgency: batch.failed > 0 ? 'critical' : 'low',
    key: `batch:${batch.batchId}:${status}`,
    groupId: 'yami.batches'
  };
}
