/**
 * Top-level panels (settings, logs), the media preview and the setup
 * wizard. Panel bodies are code-split and wrapped in error boundaries.
 */
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { ScrollText, Settings as SettingsIcon } from 'lucide-react';
import { isHostReady } from '../features/host/host-store.ts';
import { shouldShowSetup } from '../features/settings/runtime/setup-visibility.ts';
import { useT } from '../shared/i18n/i18n-context.tsx';
import { AppModal } from '../shared/ui/AppModal.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { useHost, usePreview, useServices, useUi } from './services-context.tsx';

const SettingsPanel = lazy(() =>
  import('../features/settings/SettingsPanel.tsx').then((m) => ({ default: m.SettingsPanel }))
);
const LogsPanel = lazy(() => import('../features/logs/LogsPanel.tsx').then((m) => ({ default: m.LogsPanel })));
const PreviewModal = lazy(() =>
  import('../features/preview/PreviewModal.tsx').then((m) => ({ default: m.PreviewModal }))
);
const SetupWizard = lazy(() =>
  import('../features/settings/runtime/SetupWizard.tsx').then((m) => ({ default: m.SetupWizard }))
);

function PanelFallback() {
  const t = useT();
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-text-3" role="status">
      {t.t('ui.common.loading')}
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PanelFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function SetupGate() {
  const { ui } = useServices();
  const settingsOpen = useUi((state) => state.panels.settings);
  const dismissed = useUi((state) => state.setupDismissed);
  const [open, setOpen] = useState(false);
  // Boolean selector: the gate does not re-render on every host snapshot.
  const show = useHost((state) =>
    shouldShowSetup({
      runtime: state.state?.runtime ?? null,
      hostReady: isHostReady(state),
      settingsOpen,
      dismissedThisSession: dismissed,
      open
    })
  );
  if (show !== open) setOpen(show);
  if (!show) return null;
  return (
    <Panel>
      <SetupWizard
        onClose={() => {
          ui.getState().dismissSetup();
          setOpen(false);
        }}
      />
    </Panel>
  );
}

export function PanelHost() {
  const t = useT();
  const { ui } = useServices();
  const panels = useUi((state) => state.panels);
  const previewOpen = usePreview((state) => state.current !== null);

  return (
    <>
      <AppModal
        open={panels.settings}
        onClose={() => ui.getState().closePanel('settings')}
        title={t.t('ui.modal.settings')}
        icon={SettingsIcon}
        size="lg"
      >
        <Panel>
          <SettingsPanel />
        </Panel>
      </AppModal>
      <AppModal
        open={panels.logs}
        onClose={() => ui.getState().closePanel('logs')}
        title={t.t('ui.modal.logs')}
        icon={ScrollText}
        size="xl"
        ariaLabel={t.t('ui.modal.logsAria')}
        panelClassName="h-[clamp(440px,76vh,620px)]"
        bodyClassName="flex !overflow-hidden !p-0"
      >
        <Panel>
          <LogsPanel />
        </Panel>
      </AppModal>
      {previewOpen ? (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <PreviewModal />
          </Suspense>
        </ErrorBoundary>
      ) : null}
      <SetupGate />
    </>
  );
}
