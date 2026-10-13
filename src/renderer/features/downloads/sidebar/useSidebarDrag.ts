/**
 * Drag-and-drop of conversations between sidebar folders (mouse only; the row
 * menu offers the same "Move to" action for keyboard users).
 */
import { useCallback, useRef, useState, type DragEvent } from 'react';
import { CONVERSATION_DRAG_MIME } from './folder-colors.ts';

export const UNFILED_TARGET = '__unfiled__';

export interface DropTargetHandlers {
  readonly onDragEnter: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave: () => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

export interface SidebarDrag {
  readonly dragging: { readonly id: string; readonly folderId: string | null } | null;
  readonly dropTarget: string | null;
  readonly start: (event: DragEvent<HTMLElement>, conversationId: string, folderId: string | null) => void;
  readonly end: () => void;
  /** Handlers for a folder (or `UNFILED_TARGET`) drop zone. */
  readonly target: (
    targetId: string,
    onDropped: (conversationId: string) => void,
    onEnter?: () => void
  ) => DropTargetHandlers;
}

export function useSidebarDrag(): SidebarDrag {
  const [dragging, setDragging] = useState<{ id: string; folderId: string | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const depth = useRef(new Map<string, number>());

  const end = useCallback(() => {
    setDragging(null);
    setDropTarget(null);
    depth.current.clear();
  }, []);

  const start = useCallback((event: DragEvent<HTMLElement>, conversationId: string, folderId: string | null) => {
    event.dataTransfer.setData(CONVERSATION_DRAG_MIME, conversationId);
    event.dataTransfer.effectAllowed = 'move';
    setDragging({ id: conversationId, folderId });
  }, []);

  const target = useCallback(
    (targetId: string, onDropped: (conversationId: string) => void, onEnter?: () => void): DropTargetHandlers => {
      const source = dragging?.folderId ?? UNFILED_TARGET;
      const accepts = dragging !== null && source !== targetId;
      const isConversationDrag = (event: DragEvent<HTMLElement>): boolean =>
        dragging !== null || event.dataTransfer.types.includes(CONVERSATION_DRAG_MIME);
      return {
        onDragEnter(event) {
          if (!isConversationDrag(event)) return;
          event.preventDefault();
          depth.current.set(targetId, (depth.current.get(targetId) ?? 0) + 1);
          if (!accepts) return;
          setDropTarget(targetId);
          onEnter?.();
        },
        onDragLeave() {
          const next = Math.max(0, (depth.current.get(targetId) ?? 0) - 1);
          depth.current.set(targetId, next);
          if (next === 0) setDropTarget((current) => (current === targetId ? null : current));
        },
        onDragOver(event) {
          if (!isConversationDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = accepts ? 'move' : 'none';
        },
        onDrop(event) {
          event.preventDefault();
          const id = event.dataTransfer.getData(CONVERSATION_DRAG_MIME) || dragging?.id || null;
          end();
          if (id && accepts) onDropped(id);
        }
      };
    },
    [dragging, end]
  );

  return { dragging, dropTarget, start, end, target };
}
