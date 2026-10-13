/** Engine/host log viewer. Loads the host's recent history on open, then follows live events. */
import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  CornerDownRight,
  ScrollText,
  Trash2,
  type LucideIcon
} from 'lucide-react';
import type { LogLevel } from '../../../shared/contracts/dto.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import { useLogs, useServices } from '../../app/services-context.tsx';
import { useFormat, useT } from '../../shared/i18n/i18n-context.tsx';
import { formatLogEntry } from '../../shared/i18n/text.ts';
import { Button } from '../../shared/ui/button.tsx';
import { InlineError } from '../../shared/ui/InlineError.tsx';
import { LabeledSwitch } from '../../shared/ui/labeled-switch.tsx';

const LEVEL_META: Record<LogLevel, { icon: LucideIcon; color: string; label: MessageKey; accent: string }> = {
  info: { icon: CircleDot, color: 'text-text-3', label: 'ui.logs.level.info', accent: 'border-l-transparent' },
  success: { icon: CheckCircle2, color: 'text-ok', label: 'ui.logs.level.success', accent: 'border-l-ok/50' },
  warn: { icon: AlertTriangle, color: 'text-warn', label: 'ui.logs.level.warn', accent: 'border-l-warn/50' },
  error: { icon: AlertCircle, color: 'text-err', label: 'ui.logs.level.error', accent: 'border-l-err/60' },
  muted: { icon: CircleDot, color: 'text-text-4', label: 'ui.logs.level.muted', accent: 'border-l-transparent' },
  cmd: { icon: CornerDownRight, color: 'text-text', label: 'ui.logs.level.cmd', accent: 'border-l-border-3' }
};

export function LogsPanel() {
  const t = useT();
  const format = useFormat();
  const { logs } = useServices();
  const entries = useLogs((state) => state.entries);
  const error = useLogs((state) => state.error);
  const loading = useLogs((state) => state.loading);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void logs.getState().loadRecent();
  }, [logs]);

  useEffect(() => {
    const list = listRef.current;
    if (follow && list) list.scrollTop = list.scrollHeight;
  }, [entries, follow]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <p className="type-caption m-0">
          {entries.length === 0 ? t.t('ui.logs.countNone') : t.t('ui.logs.count', { count: entries.length })}
        </p>
        <div className="flex items-center gap-3">
          <LabeledSwitch
            id="logs-follow"
            checked={follow}
            onCheckedChange={setFollow}
            label={t.t('ui.logs.follow')}
            ariaLabel={t.t('ui.logs.followAria')}
          />
          <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => logs.getState().clear()}
            disabled={entries.length === 0}
            title={t.t('ui.logs.clear')}
          >
            <Trash2 strokeWidth={1.75} aria-hidden />
            {t.t('ui.logs.clear')}
          </Button>
        </div>
      </div>
      {error ? (
        <InlineError
          className="shrink-0"
          title={t.t('ui.logs.loadFail')}
          error={error}
          retrying={loading}
          onRetry={() => void logs.getState().loadRecent()}
        />
      ) : null}
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t.t('ui.logs.aria')}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-border/80 bg-input/50 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
      >
        {entries.length === 0 ? (
          <div className="flex h-full min-h-44 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
            <span
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/80 bg-surface-2 text-text-4"
              aria-hidden
            >
              <ScrollText className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <p className="type-heading m-0">{t.t('ui.logs.emptyTitle')}</p>
            <p className="type-caption m-0 max-w-sm">{t.t('ui.logs.emptyHint')}</p>
          </div>
        ) : (
          <ul className="m-0 list-none space-y-0 p-0">
            {entries.map((entry, index) => {
              const meta = LEVEL_META[entry.level];
              const Icon = meta.icon;
              return (
                <li
                  key={`${entry.ts}-${index}`}
                  className={`flex items-start gap-2.5 border-b border-l-2 border-border/40 px-3 py-2 last:border-b-0 ${meta.accent} ${entry.level === 'cmd' ? 'bg-surface-2/35' : ''}`}
                >
                  <time dateTime={new Date(entry.ts).toISOString()} className="type-meta shrink-0 pt-0.5 text-text-4">
                    {format.time(entry.ts)}
                  </time>
                  <span className={`mt-0.5 shrink-0 ${meta.color}`} title={t.t(meta.label)}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                    <span className="sr-only">{t.t(meta.label)}</span>
                  </span>
                  <span
                    className={`min-w-0 flex-1 break-all font-mono text-xs leading-relaxed ${entry.level === 'cmd' ? 'font-medium text-text' : meta.color}`}
                  >
                    {formatLogEntry(t, entry)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
