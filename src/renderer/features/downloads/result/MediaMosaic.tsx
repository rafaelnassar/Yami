/** Featured media + up to four smaller tiles; "+N" on the last tile when there are more files. */
import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import type { MediaFileDto } from '../../../../shared/contracts/dto.ts';
import { useReducedMotion } from '../../../shared/hooks/useReducedMotion.ts';
import { DURATION, EASE_OUT_EXPO } from '../../../shared/lib/motion.ts';
import { mosaicFiles } from '../store/conversation-model.ts';
import { MediaTile } from './MediaTile.tsx';

const MOSAIC_LIMIT = 5;

export interface MediaMosaicProps {
  readonly files: readonly MediaFileDto[];
  readonly totalCount: number;
  readonly sourceUrl: string;
  readonly onOpen: (file: MediaFileDto) => void;
}

/** Memoized: the result card re-renders on every progress tick while a download runs. */
export const MediaMosaic = memo(function MediaMosaic({ files, totalCount, sourceUrl, onOpen }: MediaMosaicProps) {
  const reduceMotion = useReducedMotion();
  const shown = useMemo(() => mosaicFiles(files, MOSAIC_LIMIT), [files]);
  const featured = shown[0];
  if (!featured) return null;
  const rest = shown.slice(1);
  const overflow = Math.max(0, totalCount - shown.length);

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0.01 : DURATION.short, ease: EASE_OUT_EXPO }}
      className="flex h-full min-h-0 flex-col"
    >
      <div
        className={`grid min-h-0 flex-1 gap-2 ${rest.length === 0 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]'}`}
      >
        <MediaTile file={featured} sourceUrl={sourceUrl} featured onOpen={onOpen} />
        {rest.length > 0 ? (
          <div
            className={`grid min-h-0 content-stretch gap-2 ${rest.length <= 2 ? 'grid-cols-1 grid-rows-2' : 'grid-cols-2 grid-rows-2'}`}
          >
            {rest.map((file, index) => (
              <MediaTile
                key={file.path}
                file={file}
                sourceUrl={sourceUrl}
                onOpen={onOpen}
                overlay={index === rest.length - 1 && overflow > 0 ? `+${overflow}` : undefined}
              />
            ))}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
});
