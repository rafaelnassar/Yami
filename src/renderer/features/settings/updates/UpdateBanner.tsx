/**
 * "Update ready — restart to update" banner (app auto-update via main). The portable build
 * (`manual` status) gets a dismissible "new version available — download on GitHub" banner.
 */
import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { RELEASES_URL } from '../../../../shared/contracts/ipc.ts';
import { useServices, useUpdates } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { errorText, key } from '../../notices/notices-store.ts';

const BANNER = 'flex shrink-0 items-center gap-3 border-b border-ok/25 bg-ok/10 px-4 py-2 text-xs text-text-2';
const ACTION = 'min-h-9 shrink-0 border-ok/40 bg-ok/15 px-3 text-text hover:bg-ok/25 disabled:opacity-50';

export function UpdateBanner() {
  const t = useT();
  const { updates, notices, actions } = useServices();
  const status = useUpdates((state) => state.status);
  const busy = useUpdates((state) => state.busy);
  /** Version whose "available" banner the user closed (portable build; this session only). */
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (status.state === 'manual') {
    const version = status.version;
    if (version === null || version === dismissed) return null;
    return (
      <div role="status" className={BANNER}>
        <Download className="h-4 w-4 shrink-0 text-ok" strokeWidth={1.75} aria-hidden />
        <p className="m-0 min-w-0 flex-1 truncate">{t.t('ui.updates.manual.availableBanner', { version })}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void actions.files.openExternal(RELEASES_URL)}
          className={ACTION}
        >
          {t.t('ui.updates.manual.openReleases')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setDismissed(version)}
          aria-label={t.t('ui.common.close')}
          title={t.t('ui.common.close')}
          className="shrink-0 text-text-3 hover:bg-ok/15 hover:text-text"
        >
          <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </Button>
      </div>
    );
  }

  if (status.state !== 'ready') return null;

  const install = async (): Promise<void> => {
    const error = await updates.getState().install();
    if (error)
      notices.getState().push({ kind: 'error', title: key('ui.updates.installFail'), message: errorText(error) });
  };

  return (
    <div role="status" className={BANNER}>
      <Download className="h-4 w-4 shrink-0 text-ok" strokeWidth={1.75} aria-hidden />
      <p className="m-0 min-w-0 flex-1 truncate">{t.t('ui.updates.readyBanner', { version: status.version })}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void install()}
        disabled={busy}
        className={ACTION}
      >
        {t.t('ui.updates.restartToUpdate')}
      </Button>
    </div>
  );
}
