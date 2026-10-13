/** Rename / stop / delete dialogs for a conversation. */
import { useId, useState } from 'react';
import { Pencil } from 'lucide-react';
import { LIMITS } from '../../../../shared/contracts/host-protocol.ts';
import { isActiveStatus, type ConversationSummaryDto } from '../../../../shared/contracts/dto.ts';
import { useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { AppModal } from '../../../shared/ui/AppModal.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { Checkbox } from '../../../shared/ui/checkbox.tsx';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog.tsx';
import { Input } from '../../../shared/ui/input.tsx';
import { Label } from '../../../shared/ui/label.tsx';

export function RenameConversationDialog({
  conversationId,
  title,
  onClose
}: {
  conversationId: string;
  title: string;
  onClose: () => void;
}) {
  const t = useT();
  const { actions } = useServices();
  const fieldId = useId();
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const next = draft.trim();
    if (!next || next === title) {
      onClose();
      return;
    }
    setSaving(true);
    const ok = await actions.downloads.rename(conversationId, next);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <AppModal
      open
      onClose={onClose}
      dismissible={!saving}
      title={t.t('ui.session.rename.title')}
      icon={Pencil}
      size="md"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) void save();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor={fieldId}>{t.t('ui.session.rename.label')}</Label>
          <Input
            id={fieldId}
            type="text"
            data-autofocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            maxLength={LIMITS.maxTitleLength}
            spellCheck={false}
            disabled={saving}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t.t('ui.common.cancel')}
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={saving || !draft.trim()}>
            {saving ? t.t('ui.session.rename.saving') : t.t('ui.common.save')}
          </Button>
        </div>
      </form>
    </AppModal>
  );
}

export function StopConversationDialog({
  conversationId,
  title,
  onClose
}: {
  conversationId: string;
  title: string;
  onClose: () => void;
}) {
  const t = useT();
  const { actions } = useServices();
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open
      title={t.t('ui.session.stop.title')}
      message={t.t('ui.session.stop.message', { title })}
      confirmLabel={busy ? t.t('ui.session.stop.stopping') : t.t('ui.session.stop.confirm')}
      cancelLabel={t.t('ui.session.stop.cancel')}
      danger
      busy={busy}
      onCancel={onClose}
      onConfirm={() => {
        setBusy(true);
        void actions.downloads.lifecycle('downloads.stop', conversationId).finally(() => {
          setBusy(false);
          onClose();
        });
      }}
    />
  );
}

export function DeleteConversationDialog({
  conversation,
  onClose
}: {
  conversation: ConversationSummaryDto;
  onClose: () => void;
}) {
  const t = useT();
  const { actions } = useServices();
  const [busy, setBusy] = useState(false);
  // Opt-in: removing the history entry must never delete files by accident.
  const [deleteFiles, setDeleteFiles] = useState(false);
  const fileCount = conversation.counters.done;
  const message = [
    t.t('ui.session.delete.conversationBase', { title: conversation.title }),
    isActiveStatus(conversation.status) ? t.t('ui.session.delete.conversationActive') : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <ConfirmDialog
      open
      title={t.t('ui.session.delete.conversationTitle')}
      message={message}
      confirmLabel={busy ? t.t('ui.session.delete.conversationDeleting') : t.t('ui.session.delete.conversationConfirm')}
      cancelLabel={t.t('ui.common.cancel')}
      danger
      busy={busy}
      onCancel={onClose}
      onConfirm={() => {
        setBusy(true);
        void actions.downloads.deleteConversation(conversation.id, deleteFiles).finally(() => {
          setBusy(false);
          onClose();
        });
      }}
    >
      <Label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-input/60 px-3 py-2.5 text-sm text-text-2">
        <Checkbox
          className="mt-0.5"
          checked={deleteFiles}
          disabled={busy}
          onCheckedChange={(checked) => setDeleteFiles(checked === true)}
        />
        <span>
          {fileCount > 0
            ? t.t('ui.session.delete.alsoFilesCount', { count: fileCount })
            : t.t('ui.session.delete.alsoFiles')}
        </span>
      </Label>
    </ConfirmDialog>
  );
}
