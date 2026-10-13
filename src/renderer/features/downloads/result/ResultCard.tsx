/** The open conversation: header, metadata, live progress, media and alerts. */
import { useCallback, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Grid2x2, LayoutPanelLeft } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { isActiveStatus, type ConversationDetailDto, type MediaFileDto } from '../../../../shared/contracts/dto.ts';
import { filterMediaFiles } from '../../../../shared/domain/media.ts';
import { useActiveConversation, useHost, useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { FLOAT_LAYER_CLASS } from '../../../shared/lib/motion.ts';
import { parentFolderName } from '../../../shared/lib/paths.ts';
import { Button } from '../../../shared/ui/button.tsx';
import { InlineError } from '../../../shared/ui/InlineError.tsx';
import { isPreviewable, refFromMediaFile } from '../../preview/preview-store.ts';
import { effectiveStatus, liveProgressOf } from '../store/conversation-model.ts';
import { ConversationFilesGrid } from './ConversationFilesGrid.tsx';
import { ConversationProgress } from './ConversationProgress.tsx';
import { MediaMosaic } from './MediaMosaic.tsx';
import { ResultHeader } from './ResultHeader.tsx';
import { ResultMeta } from './ResultMeta.tsx';
import { CollectingState, FinishedWithoutMedia, resolveResultBanner, ResultAlert } from './ResultStates.tsx';

export function ResultCard({
  conversation,
  files: rawFiles
}: {
  conversation: ConversationDetailDto;
  files: readonly MediaFileDto[];
}) {
  const t = useT();
  const { actions, active, preview, ui } = useServices();
  const filesError = useActiveConversation((state) => state.filesError);
  const pixivConnected = useHost((state) => state.state?.config.accounts.pixiv.connected ?? false);
  const [showAll, setShowAll] = useState(false);
  // Flat, shallow-compared record: other conversations' progress does not re-render this card.
  const live = useHost(useShallow((state) => liveProgressOf(state.state, conversation.id)));
  const status = effectiveStatus(conversation.status, live);
  const files = useMemo(() => filterMediaFiles(rawFiles), [rawFiles]);
  const liveDone = live?.kind === 'running' ? live.done : null;
  const liveSkipped = live?.skipped ?? 0;
  const liveErrors = live?.errors ?? 0;
  const counters = useMemo(
    () => (liveDone === null ? conversation.counters : { done: liveDone, skipped: liveSkipped, errors: liveErrors }),
    [conversation.counters, liveDone, liveErrors, liveSkipped]
  );
  const fileCount = Math.max(conversation.filesCount, rawFiles.length);
  const first = files[0] ?? null;
  const banner = useMemo(
    () => resolveResultBanner({ ...conversation, filesCount: fileCount }, { pixivConnected }),
    [conversation, fileCount, pixivConnected]
  );
  const downloads = actions.downloads;

  const sourceUrl = conversation.sourceUrl;
  // Stable while the files do not change, so the memoized media grids skip progress ticks.
  const openFile = useCallback(
    (file: MediaFileDto): void => {
      if (!isPreviewable(file.mediaType)) {
        void actions.files.openFile(file.path);
        return;
      }
      const hints = [sourceUrl];
      preview.getState().open(
        refFromMediaFile(file, hints),
        files.map((item) => refFromMediaFile(item, hints))
      );
    },
    [actions.files, files, preview, sourceUrl]
  );

  const showProgress = isActiveStatus(status) && live !== null;

  return (
    <motion.article
      initial={false}
      animate={{ opacity: 1 }}
      className={`result-card flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border-2 bg-surface shadow-panel ${FLOAT_LAYER_CLASS}`}
    >
      <ResultHeader
        sourceUrl={conversation.sourceUrl}
        status={status}
        canPreview={first !== null}
        canReveal={first !== null}
        onOpenSource={() => void actions.files.openExternal(conversation.sourceUrl)}
        onPreview={() => first && openFile(first)}
        onReveal={() => first && void actions.files.revealFile(first.path)}
        onPause={() => void downloads.lifecycle('downloads.pause', conversation.id)}
        onResume={() => void downloads.lifecycle('downloads.resume', conversation.id)}
        onStop={() =>
          ui
            .getState()
            .openDialog({ kind: 'stop-conversation', conversationId: conversation.id, title: conversation.title })
        }
        onRestart={() => void downloads.lifecycle('downloads.restart', conversation.id)}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-3.5 sm:px-5">
        <div className="flex shrink-0 items-start justify-between gap-3">
          <ResultMeta
            fileCount={fileCount}
            primaryMediaType={conversation.primaryMediaType}
            totalBytes={conversation.totalBytes}
            folderName={first ? parentFolderName(first.path) : ''}
            counters={counters}
          />
          {files.length > 1 ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => setShowAll((value) => !value)}
              aria-pressed={showAll}
              className="shrink-0 gap-2 font-medium"
            >
              {showAll ? (
                <LayoutPanelLeft strokeWidth={1.75} aria-hidden />
              ) : (
                <Grid2x2 strokeWidth={1.75} aria-hidden />
              )}
              {showAll ? t.t('ui.result.showHighlights') : t.t('ui.result.showAll', { count: fileCount })}
            </Button>
          ) : null}
        </div>
        {showProgress && live ? (
          <div className="shrink-0">
            <ConversationProgress live={live} />
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">
          {files.length === 0 && filesError ? (
            <InlineError
              title={t.t('ui.result.filesLoadFail')}
              error={filesError}
              onRetry={() => void active.getState().retryFiles()}
            />
          ) : files.length > 0 ? (
            showAll ? (
              <ConversationFilesGrid files={files} sourceUrl={conversation.sourceUrl} onOpen={openFile} />
            ) : (
              <MediaMosaic files={files} totalCount={fileCount} sourceUrl={conversation.sourceUrl} onOpen={openFile} />
            )
          ) : isActiveStatus(status) ? (
            <CollectingState />
          ) : (
            <FinishedWithoutMedia conversation={conversation} />
          )}
        </div>
        {banner ? <ResultAlert banner={banner} /> : null}
      </div>
    </motion.article>
  );
}
