import { Code2, Download, Film, Images, RefreshCw, Terminal, Video, type LucideIcon } from 'lucide-react';
import type { ToolStatusDto } from '../../../../shared/contracts/dto.ts';
import type { ToolId } from '../../../../shared/domain/engine.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Badge } from '../../../shared/ui/badge.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';
import { TOOL_LABELS } from '../../notices/toast-text.ts';
import { canMutateTool, SOURCE_KEYS } from './runtime-tools.ts';

const TOOL_ICONS: Record<ToolId, LucideIcon> = {
  'gallery-dl': Images,
  'yt-dlp': Video,
  deno: Code2,
  ffmpeg: Film,
  python: Terminal
};

export interface RuntimeToolRowProps {
  readonly tool: ToolStatusDto;
  readonly first: boolean;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onInstallOrUpdate: (tool: ToolId) => void;
}

export function RuntimeToolRow({ tool, first, disabled, busy, onInstallOrUpdate }: RuntimeToolRowProps) {
  const t = useT();
  const Icon = TOOL_ICONS[tool.id];
  const mutable = canMutateTool(tool);
  const showInstall = !tool.installed && mutable;
  const showUpdate = tool.installed && tool.updateAvailable && mutable;
  const detail = !tool.installed
    ? t.t('ui.runtime.tool.missing')
    : showUpdate && tool.latestVersion
      ? t.t('ui.runtime.tool.versionRange', { current: tool.version ?? '—', latest: tool.latestVersion })
      : [tool.version, t.t(SOURCE_KEYS[tool.source])].filter(Boolean).join(' · ');

  return (
    <li className={`flex min-h-11 items-center gap-3 px-3 py-2 ${first ? '' : 'border-t border-border/80'}`}>
      <span
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/80 bg-surface text-text-3"
        aria-hidden
      >
        <Icon className="icon-inline" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="type-heading m-0 truncate">{TOOL_LABELS[tool.id]}</p>
        <p className="type-caption m-0 truncate" title={tool.path ?? undefined}>
          {detail}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {showUpdate ? (
          <Badge variant="warn" shape="pill">
            {t.t('ui.runtime.tool.updateAvailable')}
          </Badge>
        ) : tool.installed ? (
          <Badge variant="subtle" shape="pill">
            {t.t('ui.runtime.tool.ready')}
          </Badge>
        ) : null}
        {showInstall || showUpdate ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => onInstallOrUpdate(tool.id)}
            aria-label={`${showInstall ? t.t('ui.runtime.tool.install') : t.t('ui.runtime.tool.update')} ${TOOL_LABELS[tool.id]}`}
            className="shrink-0 border-warn/40 bg-warn/10 text-warn hover:border-warn/60 hover:bg-warn/15"
          >
            {busy ? (
              <Spinner />
            ) : showInstall ? (
              <Download strokeWidth={1.75} aria-hidden />
            ) : (
              <RefreshCw strokeWidth={1.75} aria-hidden />
            )}
            {showInstall ? t.t('ui.runtime.tool.install') : t.t('ui.runtime.tool.update')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
