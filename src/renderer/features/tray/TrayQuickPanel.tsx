/** Tray quick panel: compact floating composer (transparent window). */
import { useEffect, useLayoutEffect, useRef, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AppWindow, ArrowUp, Check, ClipboardPaste, Images, Power, Video, X } from 'lucide-react';
import type { Engine } from '../../../shared/domain/engine.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import { useServices } from '../../app/services-context.tsx';
import { useReducedMotion } from '../../shared/hooks/useReducedMotion.ts';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { formatError } from '../../shared/i18n/text.ts';
import { DURATION, EASE_OUT_EXPO, FLOAT_LAYER_CLASS, motionDuration, popoverMotion } from '../../shared/lib/motion.ts';
import { Button } from '../../shared/ui/button.tsx';
import { Label } from '../../shared/ui/label.tsx';
import { Spinner } from '../../shared/ui/spinner.tsx';
import { ClipboardSuggestion } from './ClipboardSuggestion.tsx';
import { trayWindowHeight } from './tray-model.ts';
import { useTrayPanel } from './useTrayPanel.ts';

const ENGINES: ReadonlyArray<{ id: Engine; label: MessageKey; icon: typeof Images }> = [
  { id: 'gallery-dl', label: 'ui.composer.engine.gallery', icon: Images },
  { id: 'yt-dlp', label: 'ui.composer.engine.video', icon: Video }
];

export function TrayQuickPanel() {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const { client } = useServices();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLFormElement>(null);
  const tray = useTrayPanel(inputRef);
  const fade = { duration: motionDuration(reduceMotion, DURATION.fast), ease: EASE_OUT_EXPO };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const report = (): void => client.api.tray.setHeight(trayWindowHeight(panel.offsetHeight + 16));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [client]);

  const trayRef = useRef(tray);
  trayRef.current = tray;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (trayRef.current.confirmQuit) trayRef.current.setConfirmQuit(false);
      else trayRef.current.hide();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const statusText =
    tray.status?.kind === 'error'
      ? formatError(t, tray.error)
      : tray.status?.kind === 'waiting'
        ? t.t('ui.tray.waiting')
        : tray.status?.kind === 'engine-missing'
          ? t.t('ui.engine.missingMessage')
          : tray.status?.kind === 'invalid-url'
            ? t.t('ui.tray.invalidUrl')
            : null;
  const statusTone =
    tray.status?.kind === 'waiting' || tray.status?.kind === 'engine-missing' ? 'text-warn' : 'text-err';

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void tray.submit();
  };

  return (
    <motion.div
      className={`${FLOAT_LAYER_CLASS} flex w-full justify-center bg-transparent px-3 pt-2`}
      {...popoverMotion(reduceMotion, 'bottom')}
    >
      <form ref={panelRef} onSubmit={onSubmit} className="relative w-full max-w-[396px]">
        <div className="download-composer rounded-lg border border-border bg-surface px-3 pb-2 pt-2.5 transition-[border-color] duration-200 focus-within:border-focus">
          {tray.suggestion ? (
            <ClipboardSuggestion
              suggestion={tray.suggestion}
              applied={tray.url.trim() === tray.suggestion.url}
              onUse={tray.setUrl}
              onDismiss={tray.dismissSuggestion}
            />
          ) : null}
          <div className="flex items-center gap-1">
            <Label htmlFor="yami-tray-url" className="sr-only">
              {t.t('ui.tray.label')}
            </Label>
            <input
              ref={inputRef}
              id="yami-tray-url"
              type="text"
              inputMode="url"
              value={tray.url}
              onChange={(event) => tray.setUrl(event.target.value)}
              placeholder={t.t('ui.tray.placeholder')}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={tray.status?.kind === 'invalid-url'}
              aria-describedby={statusText ? 'yami-tray-help' : undefined}
              className="min-w-0 flex-1 border-0 bg-transparent px-2.5 py-1.5 font-sans text-sm text-text outline-none placeholder:text-text-4 focus:outline-none"
            />
            <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={t.t('ui.tray.actions')}>
              <AnimatePresence mode="wait" initial={false}>
                {tray.confirmQuit ? (
                  <motion.div
                    key="confirm"
                    className="flex items-center gap-1"
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    transition={fade}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => tray.setConfirmQuit(false)}
                      className="px-2 text-text-3 hover:text-text"
                    >
                      {t.t('ui.tray.quitNo')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      autoFocus
                      onClick={() => client.api.app.quit()}
                      className="px-2 font-medium text-err hover:bg-err/12"
                    >
                      {t.t('ui.tray.quitYes')}
                    </Button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="actions"
                    className="flex items-center gap-0.5"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={fade}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.t('ui.tray.openMain')}
                      title={t.t('ui.tray.openMain')}
                      onClick={() => client.api.window.showMain()}
                      className="shrink-0 text-text-3 hover:text-text"
                    >
                      <AppWindow className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-text-3 hover:text-err"
                      aria-label={t.t('ui.tray.quit')}
                      title={t.t('ui.tray.quit')}
                      onClick={() => tray.setConfirmQuit(true)}
                    >
                      <Power className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-text-3 hover:text-text"
                      aria-label={t.t('ui.tray.close')}
                      title={t.t('ui.tray.close')}
                      onClick={tray.hide}
                    >
                      <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <div
              role="radiogroup"
              aria-label={t.t('ui.composer.engineAria')}
              className="grid min-w-0 flex-1 grid-cols-2 gap-1 rounded-md border border-border bg-input p-1"
            >
              {ENGINES.map((item) => {
                const active = tray.engine === item.id;
                return (
                  <Button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => tray.setEngine(item.id)}
                    variant={active ? 'secondary' : 'ghost'}
                    size="sm"
                    className={`min-h-9 w-full gap-1.5 px-2 shadow-none ${active ? 'shadow-inset' : 'border-transparent hover:bg-surface-2/70'}`}
                  >
                    <item.icon className="h-3.5 w-3.5 shrink-0 text-text-3" strokeWidth={1.75} aria-hidden />
                    <span className="truncate">{t.t(item.label)}</span>
                  </Button>
                );
              })}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void tray.paste()}
              className="shrink-0 text-text-3 hover:text-text"
              title={t.t('ui.composer.paste')}
              aria-label={t.t('ui.composer.paste')}
            >
              <ClipboardPaste className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="icon-sm"
              disabled={!tray.canSubmit}
              className="shrink-0"
              title={t.t('ui.tray.start')}
              aria-label={t.t('ui.tray.start')}
            >
              {tray.phase === 'starting' ? (
                <Spinner className="h-4 w-4" />
              ) : tray.phase === 'ok' ? (
                <Check className="h-4 w-4" strokeWidth={2} aria-hidden />
              ) : (
                <ArrowUp className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              )}
            </Button>
          </div>

          {statusText ? (
            <p
              id="yami-tray-help"
              role={tray.status?.kind === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              className={`m-0 mt-1.5 px-1 text-xs ${statusTone}`}
            >
              {statusText}
            </p>
          ) : null}
        </div>
      </form>
    </motion.div>
  );
}
