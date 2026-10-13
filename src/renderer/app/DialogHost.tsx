/** Renders the single active confirmation/edit dialog from the UI store. */
import {
  DeleteConversationDialog,
  RenameConversationDialog,
  StopConversationDialog
} from '../features/downloads/dialogs/ConversationDialogs.tsx';
import { DeleteFilesDialog } from '../features/downloads/dialogs/FileDialogs.tsx';
import { FolderDeleteDialog, FolderEditDialog } from '../features/downloads/dialogs/FolderDialogs.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { useServices, useUi } from './services-context.tsx';

export function DialogHost() {
  const { ui } = useServices();
  const dialog = useUi((state) => state.dialog);
  if (!dialog) return null;
  const close = (): void => ui.getState().closeDialog();

  const content = (() => {
    switch (dialog.kind) {
      case 'rename-conversation':
        return <RenameConversationDialog conversationId={dialog.conversationId} title={dialog.title} onClose={close} />;
      case 'stop-conversation':
        return <StopConversationDialog conversationId={dialog.conversationId} title={dialog.title} onClose={close} />;
      case 'delete-conversation':
        return <DeleteConversationDialog conversation={dialog.conversation} onClose={close} />;
      case 'delete-files':
        return <DeleteFilesDialog title={dialog.title} label={dialog.label} paths={dialog.paths} onClose={close} />;
      case 'edit-folder':
        return <FolderEditDialog folder={dialog.folder} onClose={close} />;
      case 'delete-folder':
        return <FolderDeleteDialog folder={dialog.folder} onClose={close} />;
    }
  })();

  return <ErrorBoundary resetKey={dialog.kind}>{content}</ErrorBoundary>;
}
