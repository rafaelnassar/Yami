import { memo, useState } from 'react';
import { ChevronDown, ChevronRight, FolderInput, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { ConversationSummaryDto, FolderDto } from '../../../../shared/contracts/dto.ts';
import { useFormat, useT } from '../../../shared/i18n/i18n-context.tsx';
import { MenuButton, type MenuItemSpec } from '../../../shared/ui/Menu.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';
import { SiteAvatar } from '../../../shared/ui/SiteAvatar.tsx';
import { isWorkingStatus } from '../store/conversation-model.ts';
import { SIDEBAR_ROW_MAIN, SIDEBAR_ROW_META_HIDE, sidebarSideActionClass } from './sidebar-row-styles.ts';
import type { SidebarDrag } from './useSidebarDrag.ts';

/**
 * Memoized row: every prop must be stable across sidebar re-renders (callbacks
 * come from `useCallback`, drag state is reduced to a boolean for this row).
 */
export interface ConversationRowProps {
  readonly conversation: ConversationSummaryDto;
  readonly active: boolean;
  readonly folders: readonly FolderDto[];
  /** This row is the one being dragged. */
  readonly dragging: boolean;
  readonly onDragStart: SidebarDrag['start'];
  readonly onDragEnd: SidebarDrag['end'];
  readonly onSelect: (id: string) => void;
  readonly onRename: (conversation: ConversationSummaryDto) => void;
  readonly onDelete: (conversation: ConversationSummaryDto) => void;
  readonly onMove: (conversationId: string, folderId: string | null) => void;
}

const ICON = 'size-[1.125rem] shrink-0 text-text-3';

export const ConversationRow = memo(function ConversationRow({
  conversation,
  active,
  folders,
  dragging,
  onDragStart,
  onDragEnd,
  onSelect,
  onRename,
  onDelete,
  onMove
}: ConversationRowProps) {
  const t = useT();
  const format = useFormat();
  const [moveOpen, setMoveOpen] = useState(false);
  const working = isWorkingStatus(conversation.status);
  const dragEnabled = folders.length > 0;
  const folderId = conversation.folderId;

  const items: MenuItemSpec[] = [
    {
      id: 'rename',
      label: t.t('ui.sidebar.rename'),
      icon: <Pencil className={ICON} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onRename(conversation)
    }
  ];
  if (folders.length > 0 || folderId) {
    items.push({
      id: 'move',
      label: t.t('ui.sidebar.moveTo'),
      keepOpen: true,
      icon: <FolderInput className={ICON} strokeWidth={1.75} aria-hidden />,
      trailing: moveOpen ? (
        <ChevronDown className="h-3.5 w-3.5 text-text-4" strokeWidth={1.75} aria-hidden />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 text-text-4" strokeWidth={1.75} aria-hidden />
      ),
      onSelect: () => setMoveOpen((open) => !open)
    });
    if (moveOpen) {
      items.push({
        id: 'move-none',
        kind: 'radio',
        indent: true,
        checked: !folderId,
        disabled: !folderId,
        label: t.t('ui.folders.none'),
        icon: <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-text-4" aria-hidden />,
        onSelect: () => onMove(conversation.id, null)
      });
      for (const folder of folders) {
        items.push({
          id: `move-${folder.id}`,
          kind: 'radio',
          indent: true,
          checked: folderId === folder.id,
          disabled: folderId === folder.id,
          label: folder.name,
          icon: (
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: folder.color }} aria-hidden />
          ),
          onSelect: () => onMove(conversation.id, folder.id)
        });
      }
    }
  }
  items.push({
    id: 'delete',
    label: t.t('ui.sidebar.delete'),
    danger: true,
    icon: <Trash2 className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />,
    onSelect: () => onDelete(conversation)
  });

  return (
    <div
      className={`group relative flex items-center gap-0.5 rounded-md transition-colors duration-150 ${
        active ? 'bg-surface-2 text-text shadow-inset' : 'text-text-2 hover:bg-surface-2/60 hover:text-text'
      } ${dragging ? 'opacity-45' : ''}`}
    >
      <div
        draggable={dragEnabled}
        onDragStart={(event) => (dragEnabled ? onDragStart(event, conversation.id, folderId) : event.preventDefault())}
        onDragEnd={onDragEnd}
        title={dragEnabled ? t.t('ui.sidebar.dragHint') : undefined}
        className={`flex min-w-0 flex-1 ${dragEnabled ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        <button
          type="button"
          onClick={() => onSelect(conversation.id)}
          className={SIDEBAR_ROW_MAIN}
          aria-current={active ? 'page' : undefined}
          aria-busy={working || undefined}
        >
          <SiteAvatar sourceUrl={conversation.sourceUrl} size={18} />
          <span
            className={`min-w-0 flex-1 truncate text-sm leading-snug ${active ? 'font-medium text-text' : 'font-normal text-text-2'}`}
          >
            {conversation.title}
          </span>
          {working ? (
            <Spinner className="h-3.5 w-3.5 shrink-0 text-text-3" />
          ) : (
            <span className={SIDEBAR_ROW_META_HIDE}>{format.conversationDate(conversation.updatedAt)}</span>
          )}
        </button>
      </div>
      <MenuButton
        items={items}
        menuLabel={t.t('ui.sidebar.conversationMenu')}
        triggerLabel={t.t('ui.sidebar.conversationOptions', { title: conversation.title })}
        title={t.t('ui.sidebar.options')}
        onOpenChange={(open) => {
          if (!open) setMoveOpen(false);
        }}
        triggerClassName={sidebarSideActionClass(active)}
        triggerContent={<MoreVertical className="size-[1.125rem]" strokeWidth={1.75} aria-hidden />}
      />
    </div>
  );
});
