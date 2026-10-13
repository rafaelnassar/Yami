/**
 * One media tile of a conversation: thumbnail + an "open" button laid over it
 * as a sibling (the blur scrim, when shown, sits above and takes the click).
 */
import { memo } from 'react';
import type { MediaFileDto } from '../../../../shared/contracts/dto.ts';
import { useFormat, useT } from '../../../shared/i18n/i18n-context.tsx';
import type { ThumbnailSize } from '../../../shared/lib/media-cache.ts';
import { Button } from '../../../shared/ui/button.tsx';
import { MediaThumbnail } from '../../media/MediaThumbnail.tsx';
import { useAdultBlur } from '../../media/useAdultBlur.ts';

export interface MediaTileProps {
  readonly file: MediaFileDto;
  readonly sourceUrl: string;
  readonly featured?: boolean;
  readonly overlay?: string;
  readonly showFooter?: boolean;
  /** Thumbnail rendition; featured tiles always use `large`. */
  readonly thumbSize?: ThumbnailSize;
  readonly onOpen: (file: MediaFileDto) => void;
}

/** Memoized: parents re-render on every progress tick while a download runs. */
export const MediaTile = memo(function MediaTile({
  file,
  sourceUrl,
  featured = false,
  overlay,
  showFooter = false,
  thumbSize = 'small',
  onOpen
}: MediaTileProps) {
  const t = useT();
  const format = useFormat();
  const blur = useAdultBlur([sourceUrl, file.path]);

  return (
    <div className="result-media-thumb group relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/80 bg-input transition-[border-color,box-shadow] duration-150 hover:border-border-2 hover:shadow-float">
      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
        <MediaThumbnail
          path={file.path}
          mediaType={file.mediaType}
          blur={blur}
          large={featured}
          size={featured ? 'large' : thumbSize}
        />
        {file.mediaType === 'video' && !blur.blurred ? (
          <span className="pointer-events-none absolute left-1.5 top-1.5 z-[2] rounded-md border border-border/80 bg-bg/85 px-1.5 py-0.5 font-mono text-2xs text-text-2">
            {t.t('ui.result.videoBadge')}
          </span>
        ) : null}
        {overlay ? (
          <span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center bg-bg/55 font-mono text-sm tabular-nums text-text">
            {overlay}
          </span>
        ) : null}
        {!blur.blurred ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpen(file)}
            className="absolute inset-0 z-[3] h-full min-h-0 rounded-md border-0 bg-transparent p-0 shadow-none hover:bg-transparent"
            aria-label={t.t('ui.result.openPreviewOf', { name: file.name })}
            title={file.name}
          />
        ) : null}
      </div>
      {showFooter ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-2 py-1">
          <span className="min-w-0 truncate text-2xs text-text-2" title={file.name}>
            {file.name}
          </span>
          <span className="shrink-0 font-mono text-2xs tabular-nums text-text-4">{format.bytes(file.sizeBytes)}</span>
        </div>
      ) : null}
    </div>
  );
});
