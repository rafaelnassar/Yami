/**
 * Shown in place of the cookie-file controls while the host runs with a disabled vault
 * (its key could not be loaded): why, what still works, and the reset action.
 */
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { VaultUnavailableReason } from '../../../../shared/contracts/dto.ts';
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';
import { useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';

const REASON_TEXT: Readonly<Record<VaultUnavailableReason, MessageKey>> = {
  keystore: 'ui.vault.banner.keystore',
  corrupted: 'ui.vault.banner.corrupted',
  io: 'ui.vault.banner.io'
};

export function VaultUnavailableBanner({ reason }: { readonly reason: VaultUnavailableReason }) {
  const t = useT();
  const { actions } = useServices();
  const [busy, setBusy] = useState(false);

  const reset = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await actions.vault.reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="alert" className="space-y-2 rounded-md border border-warn/25 bg-warn/12 px-3 py-2.5">
      <p className="m-0 flex items-center gap-2 text-sm font-medium text-warn">
        <KeyRound className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
        {t.t('ui.vault.banner.title')}
      </p>
      <p className="m-0 text-xs leading-5 text-text-2">{t.t(REASON_TEXT[reason])}</p>
      <p className="m-0 text-xs leading-5 text-text-3">{t.t('ui.vault.banner.effects')}</p>
      <Button size="sm" variant="danger" onClick={() => void reset()} disabled={busy}>
        {busy ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : (
          <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        )}
        {busy ? t.t('ui.vault.resetting') : t.t('ui.vault.reset')}
      </Button>
    </div>
  );
}
