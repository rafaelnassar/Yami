import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  ListRestart,
  MoreVertical,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react';
import type { ConversationSummaryDto, FolderDto } from '../../../../shared/contracts/dto.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { MenuButton } from '../../../shared/ui/Menu.tsx';
import { cn } from '../../../shared/lib/utils.ts';
import { isRestartableStatus } from '../store/conversation-model.ts';
import { ConversationRow, type ConversationRowProps } from './ConversationRow.tsx';
import { SIDEBAR_ROW_MAIN, SIDEBAR_ROW_META_HIDE, sidebarSideActionClass } from './sidebar-row-styles.ts';
import type { SidebarDrag } from './useSidebarDrag.ts';

type RowCallbacks = Pick<ConversationRowProps, 'onSelect' | 'onRename' | 'onDelete' | 'onMove'>;

export interface FolderSectionProps extends RowCallbacks {
  readonly folder: FolderDto;
  readonly conversations: readonly ConversationSummaryDto[];
  readonly folders: readonly FolderDto[];
  readonly activeId: string | null;
  readonly isPendingTarget: boolean;
  readonly drag: SidebarDrag;
  readonly onToggle: (folder: FolderDto) => void;
  readonly onExpand: (folder: FolderDto) => void;
  readonly onNewInFolder: (folderId: string) => void;
  readonly onEdit: (folder: FolderDto) => void;
  readonly onDeleteFolder: (folder: FolderDto) => void;
  readonly onRestartAll: (conversations: readonly ConversationSummaryDto[]) => void;
}

export function FolderSection(props: FolderSectionProps) {
  const t = useT();
  const { folder, conversations, drag } = props;
  const restartable = conversations.filter((item) => isRestartableStatus(item.status));
  const dropHandlers = drag.target(
    folder.id,
    (id) => props.onMove(id, folder.id),
    () => {
      if (folder.collapsed) props.onExpand(folder);
    }
  );
  const highlighted = drag.dropTarget === folder.id;
  const FolderIcon = folder.collapsed ? Folder : FolderOpen;
  const revealActions = props.isPendingTarget;
  const sideAction = sidebarSideActionClass(revealActions);
  const headerRowTone = highlighted
    ? 'bg-surface-2/50'
    : props.isPendingTarget
      ? 'bg-surface-2/80 text-text-2'
      : 'hover:bg-surface-2/60';

  return (
    <div
      className={`space-y-1 rounded-md border-2 transition-colors duration-150 ${highlighted ? 'border-border-3 bg-surface-2/50' : 'border-transparent'}`}
      {...dropHandlers}
    >
      <div className={`group flex items-center gap-0.5 rounded-md transition-colors duration-150 ${headerRowTone}`}>
        <button
          type="button"
          onClick={() => props.onToggle(folder)}
          className={cn(SIDEBAR_ROW_MAIN, 'min-w-0 flex-1')}
          aria-expanded={!folder.collapsed}
        >
          {folder.collapsed ? (
            <ChevronRight className="size-[1.125rem] shrink-0 text-text-4" strokeWidth={1.75} aria-hidden />
          ) : (
            <ChevronDown className="size-[1.125rem] shrink-0 text-text-4" strokeWidth={1.75} aria-hidden />
          )}
          <FolderIcon
            className="size-[1.125rem] shrink-0"
            strokeWidth={1.75}
            aria-hidden
            style={{ color: folder.color }}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{folder.name}</span>
          <span className={SIDEBAR_ROW_META_HIDE}>{conversations.length}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => props.onNewInFolder(folder.id)}
          className={cn(sideAction, 'disabled:opacity-30 disabled:hover:!bg-transparent')}
          aria-label={t.t('ui.sidebar.newInFolder', { name: folder.name })}
          title={t.t('ui.sidebar.newInFolder', { name: folder.name })}
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={restartable.length === 0}
          onClick={() => props.onRestartAll(restartable)}
          className={cn(sideAction, 'disabled:opacity-30 disabled:hover:!bg-transparent')}
          aria-label={t.t('ui.sidebar.restartFolder', { name: folder.name })}
          title={
            restartable.length > 0
              ? t.t('ui.sidebar.restartFolderHint', { count: restartable.length })
              : t.t('ui.sidebar.restartFolderNone')
          }
        >
          <ListRestart className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </Button>
        <MenuButton
          menuLabel={t.t('ui.sidebar.folderMenu', { name: folder.name })}
          triggerLabel={t.t('ui.sidebar.folderMenu', { name: folder.name })}
          title={t.t('ui.sidebar.folderOptions')}
          width={176}
          triggerClassName={sideAction}
          triggerContent={<MoreVertical className="h-4 w-4" strokeWidth={1.75} aria-hidden />}
          items={[
            {
              id: 'new',
              label: t.t('ui.sidebar.newDownload'),
              icon: <Plus className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} aria-hidden />,
              onSelect: () => props.onNewInFolder(folder.id)
            },
            {
              id: 'edit',
              label: t.t('ui.sidebar.editFolder'),
              icon: <Pencil className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} aria-hidden />,
              onSelect: () => props.onEdit(folder)
            },
            {
              id: 'delete',
              label: t.t('ui.sidebar.deleteFolder'),
              danger: true,
              icon: <Trash2 className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />,
              onSelect: () => props.onDeleteFolder(folder)
            }
          ]}
        />
      </div>
      {!folder.collapsed ? (
        <div className="space-y-0.5 pl-3">
          {conversations.length === 0 ? (
            <Button
              type="button"
              variant="ghost"
              fullWidth
              onClick={() => props.onNewInFolder(folder.id)}
              className="min-h-9 w-full justify-start gap-2 px-2.5 py-1.5 text-left text-xs font-normal text-text-4 hover:bg-surface-2/70 hover:text-text-3"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
              {t.t('ui.sidebar.newInThisFolder')}
            </Button>
          ) : (
            conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={props.activeId === conversation.id}
                folders={props.folders}
                dragging={drag.dragging?.id === conversation.id}
                onDragStart={drag.start}
                onDragEnd={drag.end}
                onSelect={props.onSelect}
                onRename={props.onRename}
                onDelete={props.onDelete}
                onMove={props.onMove}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
