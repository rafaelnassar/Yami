/**
 * App version and auto-update status (electron-updater through main). The portable build
 * only checks (`manual` status): new versions are downloaded by hand from the releases page.
 */
import { Download, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import { RELEASES_URL, type UpdateStatus } from '../../../../shared/contracts/ipc.ts';
import { useServices, useUpdates } from '../../../app/services-context.tsx';
import { useFormat, useT } from '../../../shared/i18n/i18n-context.tsx';
import { formatError, type UiTranslator } from '../../../shared/i18n/text.ts';
import type { Formatters } from '../../../shared/i18n/format.ts';
import { Button } from '../../../shared/ui/button.tsx';
import { ProgressTrack } from '../../../shared/ui/progress-track.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';
import { errorText, key } from '../../notices/notices-store.ts';
import { SettingsBlock } from '../SettingsBlock.tsx';

const DISABLED_KEYS = {
  dev: 'ui.updates.disabled.dev',
  portable: 'ui.updates.disabled.portable',
  setting: 'ui.updates.disabled.setting',
  unsupported: 'ui.updates.disabled.unsupported'
} as const;

function statusText(t: UiTranslator, format: Formatters, status: UpdateStatus): string {
  switch (status.state) {
    case 'disabled':
      return t.t(DISABLED_KEYS[status.reason]);
    case 'idle':
      return status.checkedAt
        ? t.t('ui.updates.upToDate', { when: format.relativeTime(status.checkedAt) })
        : t.t('ui.updates.idle');
    case 'checking':
      return t.t('ui.updates.checking');
    case 'available':
      return t.t('ui.updates.available', { version: status.version });
    case 'downloading':
      return t.t('ui.updates.downloading', { version: status.version, percent: Math.round(status.percent) });
    case 'ready':
      return t.t('ui.updates.ready', { version: status.version });
    case 'error':
      return formatError(t, status.error);
    case 'manual':
      if (status.checking) return t.t('ui.updates.checking');
      if (status.error) return formatError(t, status.error);
      if (status.version) return t.t('ui.updates.manual.available', { version: status.version });
      return status.checkedAt
        ? t.t('ui.updates.upToDate', { when: format.relativeTime(status.checkedAt) })
        : t.t('ui.updates.idle');
  }
}

function isFailure(status: UpdateStatus): boolean {
  return status.state === 'error' || (status.state === 'manual' && !status.checking && status.error !== null);
}

function isChecking(status: UpdateStatus): boolean {
  return status.state === 'checking' || (status.state === 'manual' && status.checking);
}

export function UpdatesSection({ version }: { version: string | null }) {
  const t = useT();
  const format = useFormat();
  const { updates, notices, actions } = useServices();
  const status = useUpdates((state) => state.status);
  const busy = useUpdates((state) => state.busy);

  const check = async (): Promise<void> => {
    const error = await updates.getState().check();
    if (error)
      notices.getState().push({ kind: 'error', title: key('ui.updates.checkFail'), message: errorText(error) });
  };
  const install = async (): Promise<void> => {
    const error = await updates.getState().install();
    if (error)
      notices.getState().push({ kind: 'error', title: key('ui.updates.installFail'), message: errorText(error) });
  };

  return (
    <SettingsBlock
      title={t.t('ui.updates.title')}
      description={version ? t.t('ui.updates.version', { version }) : undefined}
      icon={Sparkles}
    >
      <p className={`m-0 text-xs ${isFailure(status) ? 'text-err' : 'text-text-2'}`} role="status" aria-live="polite">
        {statusText(t, format, status)}
      </p>
      {status.state === 'manual' ? <p className="m-0 text-xs text-text-3">{t.t('ui.updates.manual.hint')}</p> : null}
      {status.state === 'downloading' ? (
        <ProgressTrack percent={status.percent} label={t.t('ui.updates.title')} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {status.state === 'ready' ? (
          <Button variant="primary" onClick={() => void install()} disabled={busy}>
            <Download className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            {t.t('ui.updates.restartToUpdate')}
          </Button>
        ) : null}
        {status.state === 'manual' ? (
          <Button
            variant={status.version ? 'primary' : 'secondary'}
            onClick={() => void actions.files.openExternal(RELEASES_URL)}
          >
            <ExternalLink className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            {t.t('ui.updates.manual.openReleases')}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={() => void check()}
          disabled={busy || status.state === 'disabled' || isChecking(status) || status.state === 'downloading'}
        >
          {isChecking(status) ? <Spinner /> : <RefreshCw className="h-4 w-4" strokeWidth={1.75} aria-hidden />}
          {t.t('ui.updates.check')}
        </Button>
      </div>
    </SettingsBlock>
  );
}
