/** Toast stack (top-right). No backdrop blur: it flickers in Electron while mounting. */
import { useCallback, useMemo } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useNotices, useServices } from '../../app/services-context.tsx';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import type { Toast } from './notices-store.ts';
import { ToastItem } from './ToastItem.tsx';

export function ToastStack() {
  const t = useT();
  const { notices, actions, ui } = useServices();
  const toasts = useNotices((state) => state.toasts);
  const ordered = useMemo(() => [...toasts].reverse(), [toasts]);
  const dismiss = useCallback((id: string) => notices.getState().dismiss(id), [notices]);

  const runAction = useCallback(
    async (toast: Toast) => {
      if (toast.action?.type === 'runtime-update') {
        const started = await actions.runtime.update(toast.action.tools);
        if (started.ok) notices.getState().remove(toast.id);
        return;
      }
      if (toast.action?.type === 'vault-reset') {
        // The notice leaves once the restarted host reports a working vault.
        await actions.vault.reset();
        return;
      }
      if (toast.action?.type === 'open-settings') {
        ui.getState().openPanel('settings');
        notices.getState().remove(toast.id);
      }
    },
    [actions.runtime, actions.vault, notices, ui]
  );

  return (
    <section
      className="pointer-events-none absolute right-4 top-4 z-50 flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2 sm:right-6"
      aria-label={t.t('ui.toast.region')}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {ordered.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} onAction={runAction} />
        ))}
      </AnimatePresence>
    </section>
  );
}
