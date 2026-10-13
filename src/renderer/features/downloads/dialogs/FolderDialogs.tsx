/** Create/edit and delete dialogs for sidebar folders. */
import { useId, useState } from 'react';
import { Check, FolderPlus } from 'lucide-react';
import { LIMITS } from '../../../../shared/contracts/host-protocol.ts';
import type { FolderDto } from '../../../../shared/contracts/dto.ts';
import { useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { AppModal } from '../../../shared/ui/AppModal.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog.tsx';
import { Input } from '../../../shared/ui/input.tsx';
import { Label } from '../../../shared/ui/label.tsx';
import { errorText, key } from '../../notices/notices-store.ts';
import { DEFAULT_FOLDER_COLOR, FOLDER_COLORS } from '../sidebar/folder-colors.ts';

function ColorSwatches({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const t = useT();
  return (
    <div
      className="flex max-h-36 flex-wrap gap-2 overflow-y-auto overscroll-contain pr-1"
      role="radiogroup"
      aria-label={t.t('ui.folders.color')}
    >
      {FOLDER_COLORS.map((color) => {
        const selected = value.toLowerCase() === color.hex.toLowerCase();
        return (
          <Button
            key={color.hex}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t.t(color.label)}
            title={t.t(color.label)}
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange(color.hex)}
            className={`h-8 w-8 ${
              selected ? 'border-border-3 bg-surface-2' : 'border-border/70 bg-input/40 hover:border-border-2'
            }`}
          >
            <span
              className="flex h-4 w-4 items-center justify-center rounded-full"
              style={{ backgroundColor: color.hex }}
            >
              {selected ? <Check className="h-2.5 w-2.5 text-bg" strokeWidth={3} aria-hidden /> : null}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

export function FolderEditDialog({ folder, onClose }: { folder: FolderDto | null; onClose: () => void }) {
  const t = useT();
  const { folders, notices } = useServices();
  const nameId = useId();
  const [name, setName] = useState(folder?.name ?? '');
  const [color, setColor] = useState(folder?.color ?? DEFAULT_FOLDER_COLOR);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    const error = folder
      ? await folders.getState().update(folder.id, { name: trimmed, color })
      : (await folders.getState().create(trimmed, color)).error;
    setSaving(false);
    if (error) {
      notices.getState().push({ kind: 'error', title: key('ui.folders.saveFail'), message: errorText(error) });
      return;
    }
    onClose();
  };

  return (
    <AppModal
      open
      onClose={onClose}
      dismissible={!saving}
      title={folder ? t.t('ui.folders.editTitle') : t.t('ui.folders.createTitle')}
      icon={FolderPlus}
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
          <Label htmlFor={nameId}>{t.t('ui.folders.name')}</Label>
          <Input
            id={nameId}
            type="text"
            data-autofocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            maxLength={LIMITS.maxFolderNameLength}
            spellCheck={false}
            placeholder={t.t('ui.folders.namePlaceholder')}
            disabled={saving}
          />
        </div>
        <div className="space-y-2">
          <Label>{t.t('ui.folders.color')}</Label>
          <ColorSwatches value={color} onChange={setColor} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t.t('ui.common.cancel')}
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={saving || !name.trim()}>
            {folder ? t.t('ui.common.save') : t.t('ui.folders.create')}
          </Button>
        </div>
      </form>
    </AppModal>
  );
}

export function FolderDeleteDialog({ folder, onClose }: { folder: FolderDto; onClose: () => void }) {
  const t = useT();
  const { folders, conversations, notices } = useServices();
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open
      title={t.t('ui.folders.deleteTitle')}
      message={t.t('ui.folders.deleteMessage', { name: folder.name })}
      confirmLabel={t.t('ui.sidebar.deleteFolder')}
      cancelLabel={t.t('ui.common.cancel')}
      danger
      busy={busy}
      onCancel={onClose}
      onConfirm={() => {
        setBusy(true);
        void folders
          .getState()
          .remove(folder.id)
          .then((error) => {
            if (error) {
              notices
                .getState()
                .push({ kind: 'error', title: key('ui.folders.deleteFail'), message: errorText(error) });
              return;
            }
            const moved = conversations
              .getState()
              .items.filter((item) => item.folderId === folder.id)
              .map((item) => item.id);
            conversations.getState().patch(moved, { folderId: null });
          })
          .finally(() => {
            setBusy(false);
            onClose();
          });
      }}
    />
  );
}
