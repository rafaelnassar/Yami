/**
 * Runtime tools: mode (executables / Python), per-tool status with install/update,
 * update-all and update checks. Operations run in the background in the host;
 * progress comes from `runtime.progress`, completion from `runtime.operationFinished`.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, Download, Package, RefreshCw, Search, Terminal } from 'lucide-react';
import type { RuntimeMode } from '../../../../shared/domain/engine.ts';
import { useHost, useRuntime, useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { Label as SectionLabel } from '../../../shared/ui/label.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';
import { RuntimeProgressBox } from './RuntimeProgressBox.tsx';
import { RuntimeToolRow } from './RuntimeToolRow.tsx';
import { orderedTools, pendingUpdates, runtimeCaption } from './runtime-tools.ts';

const MODES = [
  { id: 'standalone', title: 'ui.runtime.standalone', description: 'ui.runtime.standaloneDesc', icon: Package },
  { id: 'python', title: 'ui.runtime.python', description: 'ui.runtime.pythonDesc', icon: Terminal }
] as const;

export function RuntimeToolsPanel() {
  const t = useT();
  const { actions } = useServices();
  const runtime = useHost((state) => state.state?.runtime ?? null);
  const progress = useRuntime((state) => state.progress);
  const [optimisticMode, setOptimisticMode] = useState<RuntimeMode | null>(null);
  const [switching, setSwitching] = useState(false);
  const tools = useMemo(() => orderedTools(runtime?.tools ?? []), [runtime?.tools]);

  useEffect(() => {
    if (optimisticMode && runtime?.mode === optimisticMode) setOptimisticMode(null);
  }, [optimisticMode, runtime?.mode]);

  if (!runtime) return <p className="type-caption m-0">{t.t('ui.runtime.offline')}</p>;

  const mode = optimisticMode ?? runtime.mode;
  const busy = runtime.busy;
  const working = busy || switching;
  const pending = pendingUpdates(tools);
  const checking = busy && runtime.operation?.kind === 'check-updates';
  const busyTools = new Set(busy ? (runtime.operation?.tools ?? []) : []);
  const caption = runtimeCaption(runtime, checking, pending.length);
  const pythonMissing = mode === 'python' && !tools.find((tool) => tool.id === 'python')?.installed;

  const changeMode = async (next: RuntimeMode): Promise<void> => {
    if (next === mode || working) return;
    setOptimisticMode(next);
    setSwitching(true);
    const error = await actions.runtime.setMode(next);
    setSwitching(false);
    if (error) setOptimisticMode(null);
  };

  const onModeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    void changeMode(mode === 'standalone' ? 'python' : 'standalone');
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel>{t.t('ui.runtime.modeLabel')}</SectionLabel>
        <div
          role="radiogroup"
          aria-label={t.t('ui.runtime.modeLabel')}
          aria-busy={switching || undefined}
          onKeyDown={onModeKeyDown}
          className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-input p-1.5"
        >
          {MODES.map((item) => {
            const active = item.id === mode;
            const Icon = item.icon;
            return (
              <Button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                disabled={busy}
                onClick={() => void changeMode(item.id)}
                variant={active ? 'secondary' : 'ghost'}
                className={`flex min-h-10 w-full items-center justify-center gap-2 px-3 shadow-none ${
                  active ? 'shadow-inset' : 'border-transparent'
                }`}
              >
                {active && switching ? (
                  <Spinner className="h-4 w-4 shrink-0" />
                ) : (
                  <Icon
                    className={`h-4 w-4 shrink-0 ${active ? 'text-text-2' : 'text-text-3'}`}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                )}
                {t.t(item.title)}
              </Button>
            );
          })}
        </div>
        <p className="type-caption m-0 min-h-9 max-w-prose">
          {t.t(MODES.find((item) => item.id === mode)?.description ?? 'ui.runtime.standaloneDesc')}
        </p>
      </div>

      <ul
        className="m-0 list-none overflow-hidden rounded-md border border-border bg-input/95 p-0"
        aria-busy={busy || undefined}
      >
        {tools.map((tool, index) => (
          <RuntimeToolRow
            key={tool.id}
            tool={tool}
            first={index === 0}
            disabled={working}
            busy={busyTools.has(tool.id)}
            onInstallOrUpdate={(id) => void actions.runtime.update([id])}
          />
        ))}
      </ul>
      <p className="type-caption m-0 min-h-5 max-w-prose">
        {t.t(caption.key, caption.count !== undefined ? { count: caption.count } : undefined)}
      </p>

      {progress && (busy || progress.phase === 'error') ? (
        <RuntimeProgressBox progress={progress} working={busy} />
      ) : null}

      {pythonMissing ? <p className="type-body m-0 max-w-prose">{t.t('ui.runtime.pythonHint')}</p> : null}
      {!runtime.integrityPinned ? (
        <p className="m-0 flex items-start gap-2 rounded-md border border-warn/25 bg-warn/[0.08] px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          {t.t('ui.runtime.notPinned')}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {runtime.setupNeeded ? (
          <Button variant="primary" onClick={() => void actions.runtime.install(mode)} disabled={working}>
            {busy && runtime.operation?.kind === 'install' ? (
              <Spinner />
            ) : (
              <Download className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            )}
            {busy && runtime.operation?.kind === 'install' ? t.t('ui.runtime.installing') : t.t('ui.runtime.install')}
          </Button>
        ) : null}
        {pending.length > 0 ? (
          <Button variant="primary" onClick={() => void actions.runtime.update(pending)} disabled={working}>
            {busy && runtime.operation?.kind === 'update' ? (
              <Spinner />
            ) : (
              <RefreshCw className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            )}
            {busy && runtime.operation?.kind === 'update'
              ? t.t('ui.runtime.updating')
              : t.t('ui.runtime.updateAllCount', { count: pending.length })}
          </Button>
        ) : null}
        <Button
          variant={runtime.setupNeeded || pending.length > 0 ? 'secondary' : 'primary'}
          onClick={() => void actions.runtime.checkUpdates()}
          disabled={working}
        >
          {checking ? <Spinner /> : <Search className="h-4 w-4" strokeWidth={1.75} aria-hidden />}
          {checking ? t.t('ui.runtime.checkingUpdates') : t.t('ui.runtime.checkUpdates')}
        </Button>
      </div>
    </div>
  );
}
