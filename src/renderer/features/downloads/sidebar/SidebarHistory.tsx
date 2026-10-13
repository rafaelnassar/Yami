/** Folder sections, unfiled conversations and pagination of the history list. */
import { useCallback, useMemo } from 'react';
import type { ConversationSummaryDto, FolderDto } from '../../../../shared/contracts/dto.ts';
import {
  useActiveConversation,
  useComposer,
  useConversations,
  useFolders,
  useServices
} from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { InlineError } from '../../../shared/ui/InlineError.tsx';
import { Skeleton } from '../../../shared/ui/skeleton.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';
import { errorText, key } from '../../notices/notices-store.ts';
import { groupByFolder } from '../store/conversation-model.ts';
import { ConversationRow } from './ConversationRow.tsx';
import { FolderSection } from './FolderSection.tsx';
import { UNFILED_TARGET, useSidebarDrag } from './useSidebarDrag.ts';

export function SidebarHistory() {
  const t = useT();
  const { actions, folders: foldersStore, conversations: conversationsStore, ui, notices } = useServices();
  const conversations = useConversations((state) => state.items);
  const loading = useConversations((state) => state.loading && !state.loaded);
  const refreshing = useConversations((state) => state.loading);
  const hasMore = useConversations((state) => state.nextCursor !== null);
  const loadingMore = useConversations((state) => state.loadingMore);
  const listError = useConversations((state) => state.error);
  const folders = useFolders((state) => state.folders);
  const foldersError = useFolders((state) => state.error);
  const activeId = useActiveConversation((state) => state.id);
  const pendingFolderId = useComposer((state) => state.pendingFolderId);
  const drag = useSidebarDrag();
  const groups = useMemo(() => groupByFolder(conversations, folders), [conversations, folders]);
  const downloads = actions.downloads;

  // Stable callbacks: `ConversationRow` is memoized.
  const onRename = useCallback(
    (conversation: ConversationSummaryDto) =>
      ui
        .getState()
        .openDialog({ kind: 'rename-conversation', conversationId: conversation.id, title: conversation.title }),
    [ui]
  );
  const onDelete = useCallback(
    (conversation: ConversationSummaryDto) => ui.getState().openDialog({ kind: 'delete-conversation', conversation }),
    [ui]
  );
  const onMove = useCallback(
    (conversationId: string, folderId: string | null) => void downloads.moveToFolder([conversationId], folderId),
    [downloads]
  );
  const rowCallbacks = useMemo(
    () => ({ onSelect: downloads.selectConversation, onRename, onDelete, onMove }),
    [downloads.selectConversation, onDelete, onMove, onRename]
  );
  const setCollapsed = (folder: FolderDto, collapsed: boolean): void => {
    void foldersStore
      .getState()
      .update(folder.id, { collapsed })
      .then((error) => {
        if (error)
          notices.getState().push({ kind: 'error', title: key('ui.folders.saveFail'), message: errorText(error) });
      });
  };

  const errors = (
    <>
      {listError ? (
        <InlineError
          compact
          className="mx-1 mb-2"
          title={t.t('ui.sidebar.loadFail')}
          error={listError}
          retrying={refreshing}
          onRetry={() => void conversationsStore.getState().refresh()}
        />
      ) : null}
      {foldersError ? (
        <InlineError
          compact
          className="mx-1 mb-2"
          title={t.t('ui.sidebar.foldersLoadFail')}
          error={foldersError}
          onRetry={() => void foldersStore.getState().load()}
        />
      ) : null}
    </>
  );

  if (loading && conversations.length === 0) {
    return (
      <div className="space-y-1" role="status" aria-label={t.t('ui.sidebar.loading')}>
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="flex items-center gap-2.5 rounded-md px-2.5 py-2">
            <Skeleton className="h-[18px] w-[18px] rounded" />
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-3 w-8 bg-muted/80" />
          </div>
        ))}
      </div>
    );
  }

  if (conversations.length === 0 && folders.length === 0) {
    return listError || foldersError ? (
      errors
    ) : (
      <div className="px-3 py-8 text-center">
        <p className="m-0 text-xs leading-relaxed text-text-4">{t.t('ui.sidebar.empty')}</p>
      </div>
    );
  }

  const unfiledDrop = drag.target(UNFILED_TARGET, (id) => rowCallbacks.onMove(id, null));
  const showUnfiled =
    groups.unfiled.length > 0 || (folders.length > 0 && drag.dragging !== null && drag.dragging.folderId !== null);

  return (
    <div className="flex flex-col gap-3">
      {errors}
      {folders.map((folder) => (
        <FolderSection
          key={folder.id}
          folder={folder}
          conversations={groups.byFolder.get(folder.id) ?? []}
          folders={folders}
          activeId={activeId}
          isPendingTarget={pendingFolderId === folder.id}
          drag={drag}
          onToggle={(item) => setCollapsed(item, !item.collapsed)}
          onExpand={(item) => setCollapsed(item, false)}
          onNewInFolder={(folderId) => downloads.newDownload(folderId)}
          onEdit={(item) => ui.getState().openDialog({ kind: 'edit-folder', folder: item })}
          onDeleteFolder={(item) => ui.getState().openDialog({ kind: 'delete-folder', folder: item })}
          onRestartAll={(items) => void downloads.restartMany(items)}
          {...rowCallbacks}
        />
      ))}

      {showUnfiled ? (
        <div
          className={`space-y-1 rounded-md border-2 transition-colors duration-150 ${drag.dropTarget === UNFILED_TARGET ? 'border-border-3 bg-surface-2/50' : 'border-transparent'}`}
          {...unfiledDrop}
        >
          {folders.length > 0 ? (
            <div className="flex items-center gap-2 px-2.5 pb-0.5 pt-0.5">
              <span className="type-nav-group m-0">{t.t('ui.folders.none')}</span>
              {groups.unfiled.length > 0 ? (
                <span className="font-mono text-2xs tabular-nums text-text-4">{groups.unfiled.length}</span>
              ) : (
                <span className="text-2xs text-text-4">{t.t('ui.sidebar.dropToUnfile')}</span>
              )}
            </div>
          ) : null}
          <div className="flex flex-col gap-0.5">
            {groups.unfiled.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={activeId === conversation.id}
                folders={folders}
                dragging={drag.dragging?.id === conversation.id}
                onDragStart={drag.start}
                onDragEnd={drag.end}
                {...rowCallbacks}
              />
            ))}
          </div>
        </div>
      ) : null}

      {conversations.length === 0 && folders.length > 0 ? (
        <p className="m-0 px-3 py-4 text-center text-xs text-text-4">{t.t('ui.sidebar.emptyWithFolders')}</p>
      ) : null}

      {hasMore ? (
        <Button
          type="button"
          variant="ghost"
          fullWidth
          onClick={() => void conversationsStore.getState().loadMore()}
          disabled={loadingMore}
          className="mx-2 min-h-9 gap-2 text-xs font-normal text-text-3 hover:text-text disabled:cursor-default disabled:opacity-60"
        >
          {loadingMore ? <Spinner className="h-3.5 w-3.5" /> : null}
          {t.t('ui.sidebar.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
