/** Delete-files confirmation (one `files.delete` request). */
import { useState } from 'react';
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';
import { useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog.tsx';

export function DeleteFilesDialog({
  title,
  label,
  paths,
  onClose
}: {
  title: MessageKey;
  label: string;
  paths: readonly string[];
  onClose: () => void;
}) {
  const t = useT();
  const { actions } = useServices();
  const [busy, setBusy] = useState(false);
  const message =
    paths.length === 1
      ? t.t('ui.session.delete.fileMessage', { name: label })
      : t.t('ui.session.delete.bulkMessage', { count: paths.length, label });
  return (
    <ConfirmDialog
      open
      title={t.t(title)}
      message={message}
      confirmLabel={busy ? t.t('ui.session.delete.removing', { count: paths.length }) : t.t('ui.session.delete.remove')}
      cancelLabel={t.t('ui.common.cancel')}
      danger
      busy={busy}
      onCancel={onClose}
      onConfirm={() => {
        setBusy(true);
        void actions.downloads.deleteFiles(paths).finally(() => {
          setBusy(false);
          onClose();
        });
      }}
    />
  );
}
