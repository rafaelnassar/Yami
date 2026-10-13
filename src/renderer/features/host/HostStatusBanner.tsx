/**
 * Slim banner while the download engine (host process) is starting, restarting
 * or offline — or connected but its state snapshot could not be loaded.
 */
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import { useHost, useServices } from '../../app/services-context.tsx';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { formatError } from '../../shared/i18n/text.ts';
import { Button } from '../../shared/ui/button.tsx';
import { errorText, key } from '../notices/notices-store.ts';

const RETRY_BUTTON = 'min-h-9 shrink-0 gap-1.5 border-current/30 px-2.5 hover:bg-bg/30 disabled:opacity-50';

/** Connected, but `session.init` failed: the store retries with backoff; the user can retry now. */
function InitErrorBanner() {
  const t = useT();
  const { host } = useServices();
  const error = useHost((state) => state.initError);
  const initializing = useHost((state) => state.initializing);
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-err/25 bg-err/10 px-4 py-2 text-xs text-err"
    >
      <AlertTriangle className="icon-inline" strokeWidth={1.75} aria-hidden />
      <p className="m-0 min-w-0 flex-1 truncate">
        <span className="font-medium">{t.t('ui.host.initFail')}</span>
        <span className="text-text-3">
          {' '}
          — {formatError(t, error)} {t.t('ui.host.initRetrying')}
        </span>
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void host.getState().init()}
        disabled={initializing}
        className={RETRY_BUTTON}
      >
        <RotateCcw
          className={`h-3.5 w-3.5 ${initializing ? 'animate-spin motion-reduce:animate-none' : ''}`}
          strokeWidth={1.75}
          aria-hidden
        />
        {t.t('ui.common.retry')}
      </Button>
    </div>
  );
}

export function HostStatusBanner() {
  const t = useT();
  const { host, notices } = useServices();
  const connection = useHost((state) => state.connection);
  const restarting = useHost((state) => state.restarting);

  if (connection.state === 'ready') return <InitErrorBanner />;
  const offline = connection.state === 'offline';
  const error = connection.state === 'restarting' || connection.state === 'offline' ? connection.error : null;
  const title =
    connection.state === 'starting'
      ? t.t('ui.host.starting')
      : connection.state === 'restarting'
        ? t.t('ui.host.restarting', { attempt: connection.attempt })
        : t.t('ui.host.offline');

  const retry = async (): Promise<void> => {
    const failure = await host.getState().restart();
    if (failure)
      notices.getState().push({ kind: 'error', title: key('ui.host.restartFail'), message: errorText(failure) });
  };

  return (
    <div
      role={offline ? 'alert' : 'status'}
      aria-live="polite"
      className={`flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs ${
        offline ? 'border-err/25 bg-err/10 text-err' : 'border-warn/20 bg-warn/[0.07] text-warn'
      }`}
    >
      {offline ? (
        <AlertTriangle className="icon-inline" strokeWidth={1.75} aria-hidden />
      ) : (
        <Loader2 className="icon-inline animate-spin motion-reduce:animate-none" strokeWidth={2} aria-hidden />
      )}
      <p className="m-0 min-w-0 flex-1 truncate">
        <span className="font-medium">{title}</span>
        {error ? <span className="text-text-3"> — {formatError(t, error)}</span> : null}
      </p>
      {offline || connection.state === 'restarting' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void retry()}
          disabled={restarting}
          className={RETRY_BUTTON}
        >
          <RotateCcw
            className={`h-3.5 w-3.5 ${restarting ? 'animate-spin motion-reduce:animate-none' : ''}`}
            strokeWidth={1.75}
            aria-hidden
          />
          {t.t('ui.host.retry')}
        </Button>
      ) : null}
    </div>
  );
}
