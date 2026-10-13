/** Conversation card header: source identity and lifecycle controls. */
import type { ReactNode } from 'react';
import { ExternalLink, FolderOpen, Maximize2, Pause, Play, RotateCcw, Square } from 'lucide-react';
import type { DownloadStatus } from '../../../../shared/contracts/dto.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { siteLabel } from '../../../shared/lib/site.ts';
import { Button } from '../../../shared/ui/button.tsx';
import { SiteAvatar } from '../../../shared/ui/SiteAvatar.tsx';
import { isRestartableStatus } from '../store/conversation-model.ts';

function ControlButton({
  label,
  title,
  onClick,
  danger = false,
  children
}: {
  label: string;
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={danger ? 'destructive' : 'secondary'}
      size="icon-sm"
      onClick={onClick}
      className={
        danger
          ? 'border-border bg-transparent text-text-3 hover:border-err/40 hover:bg-err/10 hover:text-err focus-visible:outline-err'
          : 'border-border/80 text-text-3'
      }
      aria-label={label}
      title={title}
    >
      {children}
    </Button>
  );
}

export interface ResultHeaderProps {
  readonly sourceUrl: string;
  readonly status: DownloadStatus;
  readonly canPreview: boolean;
  readonly canReveal: boolean;
  readonly onOpenSource: () => void;
  readonly onPreview: () => void;
  readonly onReveal: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
  readonly onRestart: () => void;
}

const ICON = 'size-[1.125rem]';

export function ResultHeader(props: ResultHeaderProps) {
  const t = useT();
  const site = siteLabel(props.sourceUrl);
  const { status } = props;
  const canPause = status === 'running' || status === 'pending';
  const canResume = status === 'paused';
  const canStop = canPause || canResume;

  return (
    <header className="flex shrink-0 items-start gap-3 border-b border-border/70 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-2.5">
        {site ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <SiteAvatar sourceUrl={props.sourceUrl} size={20} />
            <span className="truncate text-sm font-semibold tracking-tight text-text" title={site}>
              {site}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={props.onOpenSource}
              className="shrink-0 text-text-4 hover:text-text-2"
              aria-label={t.t('ui.result.openSite', { site })}
              title={t.t('ui.result.openSite', { site })}
            >
              <ExternalLink className={ICON} strokeWidth={1.75} aria-hidden />
            </Button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={props.onOpenSource}
          className="m-0 block max-w-full cursor-pointer truncate rounded-sm border-0 bg-transparent p-0 text-left font-mono text-xs font-normal leading-relaxed text-text-4 transition-colors duration-150 hover:text-text-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          title={props.sourceUrl}
        >
          {props.sourceUrl}
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {props.canPreview ? (
          <ControlButton
            label={t.t('ui.result.openPreview')}
            title={t.t('ui.result.expandPreview')}
            onClick={props.onPreview}
          >
            <Maximize2 className={ICON} strokeWidth={1.75} aria-hidden />
          </ControlButton>
        ) : null}
        {props.canReveal ? (
          <ControlButton
            label={t.t('ui.result.openFolder')}
            title={t.t('ui.result.openFolderShort')}
            onClick={props.onReveal}
          >
            <FolderOpen className={ICON} strokeWidth={1.75} aria-hidden />
          </ControlButton>
        ) : null}
        {canPause ? (
          <ControlButton label={t.t('ui.result.pause')} title={t.t('ui.result.pauseHint')} onClick={props.onPause}>
            <Pause className={ICON} strokeWidth={1.75} aria-hidden />
          </ControlButton>
        ) : null}
        {canResume ? (
          <ControlButton label={t.t('ui.result.resume')} title={t.t('ui.result.resumeHint')} onClick={props.onResume}>
            <Play className={ICON} strokeWidth={1.75} aria-hidden />
          </ControlButton>
        ) : null}
        {canStop ? (
          <ControlButton label={t.t('ui.result.stop')} title={t.t('ui.result.stop')} onClick={props.onStop} danger>
            <Square className={ICON} strokeWidth={1.75} aria-hidden />
          </ControlButton>
        ) : null}
        {isRestartableStatus(status) ? (
          <ControlButton
            label={t.t('ui.result.restart')}
            title={t.t('ui.result.restartHint')}
            onClick={props.onRestart}
          >
            <RotateCcw className={ICON} strokeWidth={1.75} aria-hidden />
          </ControlButton>
        ) : null}
      </div>
    </header>
  );
}
