/** Every file of the open conversation, virtualized; loads further pages near the end. */
import { memo, useCallback } from 'react';
import type { MediaFileDto } from '../../../../shared/contracts/dto.ts';
import { useActiveConversation, useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { thumbnailSizeFor } from '../../../shared/lib/media-cache.ts';
import { InlineError } from '../../../shared/ui/InlineError.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';
import { VirtualGrid } from '../../../shared/ui/VirtualGrid.tsx';
import { MediaTile } from './MediaTile.tsx';

const tileHeight = (width: number): number => width + 28;

/** Memoized: the result card re-renders on every progress tick while a download runs. */
export const ConversationFilesGrid = memo(function ConversationFilesGrid({
  files,
  sourceUrl,
  onOpen
}: {
  files: readonly MediaFileDto[];
  sourceUrl: string;
  readonly onOpen: (file: MediaFileDto) => void;
}) {
  const t = useT();
  const { active } = useServices();
  const loadingFiles = useActiveConversation((state) => state.loadingFiles);
  const hasMore = useActiveConversation((state) => state.filesCursor !== null);
  const filesError = useActiveConversation((state) => state.filesError);
  // No automatic retries after a failure: the footer offers an explicit Retry.
  const loadMore = useCallback(() => {
    if (hasMore && !filesError) void active.getState().loadMoreFiles();
  }, [active, filesError, hasMore]);

  return (
    <VirtualGrid
      items={files}
      getKey={(file) => file.path}
      minItemWidth={150}
      gap={8}
      itemHeight={tileHeight}
      ariaLabel={t.t('ui.result.allFiles')}
      onEndReached={loadMore}
      renderItem={(file, _index, width) => (
        <MediaTile
          file={file}
          sourceUrl={sourceUrl}
          showFooter
          thumbSize={thumbnailSizeFor(width, window.devicePixelRatio)}
          onOpen={onOpen}
        />
      )}
      footer={
        filesError ? (
          <InlineError
            compact
            className="my-3"
            title={t.t('ui.result.filesLoadFail')}
            error={filesError}
            onRetry={() => void active.getState().retryFiles()}
          />
        ) : loadingFiles ? (
          <div className="flex items-center justify-center gap-2 py-3 text-2xs text-text-4" role="status">
            <Spinner />
            {t.t('ui.common.loadingMore')}
          </div>
        ) : null
      }
    />
  );
});
