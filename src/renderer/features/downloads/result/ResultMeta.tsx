/** Metadata line: files, size, destination folder, errors/skipped — not interactive chips. */
import type { DownloadCountersDto } from '../../../../shared/contracts/dto.ts';
import type { MediaType } from '../../../../shared/domain/media.ts';
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';
import { useFormat, useT } from '../../../shared/i18n/i18n-context.tsx';
import { countNounFor, type CountNoun } from '../store/conversation-model.ts';

const COUNT_KEYS: Record<CountNoun, MessageKey> = {
  image: 'ui.result.count.image',
  video: 'ui.result.count.video',
  audio: 'ui.result.count.audio',
  file: 'ui.result.count.file'
};

function MetaItem({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warn' }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
      <span className="shrink-0 text-2xs uppercase tracking-[0.06em] text-text-4">{label}</span>
      <span
        className={`truncate text-sm font-medium tabular-nums ${tone === 'warn' ? 'text-warn' : 'text-text-2'}`}
        title={value}
      >
        {value}
      </span>
    </span>
  );
}

export interface ResultMetaProps {
  readonly fileCount: number;
  readonly primaryMediaType: MediaType | null;
  readonly totalBytes: number;
  readonly folderName: string;
  readonly counters: DownloadCountersDto;
}

export function ResultMeta({ fileCount, primaryMediaType, totalBytes, folderName, counters }: ResultMetaProps) {
  const t = useT();
  const format = useFormat();
  const files =
    fileCount > 0
      ? t.t(COUNT_KEYS[countNounFor(primaryMediaType)], { count: fileCount })
      : t.t('ui.result.waitingFiles');
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 gap-y-2">
      <MetaItem label={t.t('ui.result.chip.files')} value={files} />
      <MetaItem label={t.t('ui.result.chip.size')} value={totalBytes > 0 ? format.bytes(totalBytes) : '—'} />
      <MetaItem label={t.t('ui.result.chip.folder')} value={folderName || '—'} />
      {counters.errors > 0 ? (
        <MetaItem label={t.t('ui.result.chip.errors')} value={format.number(counters.errors)} tone="warn" />
      ) : counters.skipped > 0 ? (
        <MetaItem label={t.t('ui.result.chip.skipped')} value={format.number(counters.skipped)} />
      ) : null}
    </div>
  );
}
