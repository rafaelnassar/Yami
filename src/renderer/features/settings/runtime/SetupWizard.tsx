/**
 * First-run tools setup. Starts on the chooser (explicit consent; the host may
 * already be auto-installing, in which case it opens on the progress step).
 */
import { useEffect, useReducer } from 'react';
import { AlertCircle, CheckCircle2, Download, ExternalLink, Loader2, Package, Terminal } from 'lucide-react';
import type { RuntimeStatusDto } from '../../../../shared/contracts/dto.ts';
import type { RuntimeMode } from '../../../../shared/domain/engine.ts';
import { useHost, useRuntime, useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { formatError, formatRuntimeProgress } from '../../../shared/i18n/text.ts';
import { AppModal } from '../../../shared/ui/AppModal.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { ProgressTrack } from '../../../shared/ui/progress-track.tsx';
import { initialSetupState, setupReducer } from './setup-wizard-model.ts';

const PYTHON_DOWNLOAD_URL = 'https://www.python.org/downloads/';

/** Id of the install the host is running (auto-install or another window), if any. */
function hostInstallIdOf(runtime: RuntimeStatusDto | null | undefined): string | null {
  return runtime?.busy === true && runtime.operation?.kind === 'install' ? runtime.operation.id : null;
}

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { actions, host } = useServices();
  const hostInstallId = useHost((state) => hostInstallIdOf(state.state?.runtime));
  const progress = useRuntime((state) => state.progress);
  const lastFinished = useRuntime((state) => state.lastFinished);
  const [wizard, dispatch] = useReducer(setupReducer, hostInstallId, initialSetupState);
  const { step, error, mode } = wizard;

  useEffect(() => {
    if (hostInstallId) dispatch({ type: 'hostInstall', operationId: hostInstallId });
  }, [hostInstallId]);

  // Re-evaluated when the followed id becomes known: the completion event may
  // arrive before the `runtime.install` response. Other operations are ignored.
  useEffect(() => {
    if (lastFinished)
      dispatch({
        type: 'finished',
        operationId: lastFinished.operationId,
        ok: lastFinished.ok,
        error: lastFinished.error,
        kind: lastFinished.kind
      });
  }, [lastFinished, wizard.operationId]);

  const start = async (next: RuntimeMode): Promise<void> => {
    dispatch({ type: 'start', mode: next });
    const started = await actions.runtime.install(next);
    if (started.ok) dispatch({ type: 'started', operationId: started.operationId });
    else
      dispatch({
        type: 'startFailed',
        error: started.error,
        hostInstallId: hostInstallIdOf(host.getState().state?.runtime)
      });
  };

  const dismiss = async (): Promise<void> => {
    // Closes even when persisting the dismissal failed (the action toasts it);
    // the session flag keeps the wizard closed until the next launch.
    await actions.runtime.dismissSetup();
    onClose();
  };

  return (
    <AppModal
      open
      onClose={() => void dismiss()}
      dismissible={step !== 'working'}
      title={t.t('ui.setup.title')}
      icon={Package}
      size="lg"
    >
      <div className="space-y-5">
        {step === 'choose' ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    id: 'standalone',
                    icon: Download,
                    title: 'ui.setup.standalone.title',
                    body: 'ui.setup.standalone.body',
                    cta: 'ui.setup.standalone.cta'
                  },
                  {
                    id: 'python',
                    icon: Terminal,
                    title: 'ui.setup.python.title',
                    body: 'ui.setup.python.body',
                    cta: 'ui.setup.python.cta'
                  }
                ] as const
              ).map((card) => (
                <div key={card.id} className="flex min-h-40 flex-col rounded-lg border border-border bg-input/95 p-4">
                  <span
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-text-3"
                    aria-hidden
                  >
                    <card.icon className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  <h3 className="type-heading m-0 mt-3">{t.t(card.title)}</h3>
                  <p className="type-caption m-0 mt-1.5 flex-1">{t.t(card.body)}</p>
                  <Button
                    {...(card.id === 'standalone' ? { 'data-autofocus': true } : {})}
                    variant={card.id === 'standalone' ? 'primary' : 'secondary'}
                    className="mt-4 w-full"
                    onClick={() => void start(card.id)}
                  >
                    {t.t(card.cta)}
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => void dismiss()}>
                {t.t('ui.setup.skip')}
              </Button>
            </div>
          </>
        ) : null}

        {step === 'working' ? (
          <div className="space-y-3" role="status" aria-live="polite">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-input text-text-3">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" strokeWidth={2} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="type-heading m-0">{t.t('ui.setup.progress')}</p>
                <p className="type-caption m-0 mt-1">
                  {progress ? formatRuntimeProgress(t, progress) : t.t('ui.setup.working')}
                </p>
                {progress?.step !== null && progress?.step !== undefined && progress.totalSteps !== null ? (
                  <p className="type-caption m-0 mt-0.5">
                    {t.t('ui.runtime.progress.step', { step: progress.step, total: progress.totalSteps })}
                  </p>
                ) : null}
              </div>
            </div>
            <ProgressTrack percent={progress?.percent ?? null} label={t.t('ui.setup.progress')} />
          </div>
        ) : null}

        {step === 'done' ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" strokeWidth={1.75} aria-hidden />
              <p className="type-body m-0">{t.t('ui.setup.done')}</p>
            </div>
            <Button data-autofocus variant="primary" onClick={() => void dismiss()}>
              {t.t('ui.setup.doneCta')}
            </Button>
          </div>
        ) : null}

        {step === 'error' ? (
          <div className="space-y-4" role="alert">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-err" strokeWidth={1.75} aria-hidden />
              <div className="min-w-0 space-y-1">
                <p className="type-heading m-0 text-err">{t.t('ui.setup.fail')}</p>
                {error ? <p className="type-caption m-0">{formatError(t, error)}</p> : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button data-autofocus variant="primary" onClick={() => dispatch({ type: 'retry' })}>
                {t.t('ui.setup.retry')}
              </Button>
              {mode === 'python' ? (
                <Button variant="secondary" onClick={() => void actions.files.openExternal(PYTHON_DOWNLOAD_URL)}>
                  <ExternalLink className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                  {t.t('ui.runtime.openPython')}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => void dismiss()}>
                {t.t('ui.setup.skip')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </AppModal>
  );
}
