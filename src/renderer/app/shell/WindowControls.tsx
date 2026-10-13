import { useEffect, useState, type CSSProperties } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { useServices, useSettings } from '../services-context.tsx';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { Button } from '../../shared/ui/button.tsx';

const SEGMENT =
  'h-10 w-10 min-h-10 min-w-10 rounded-none border-0 bg-transparent text-text-3 shadow-none hover:bg-surface-2 hover:text-text ' +
  'focus-visible:relative focus-visible:z-10 focus-visible:outline-offset-[-2px]';

/** Segmented window controls; the group is `no-drag` inside the title bar drag region. */
export function WindowControls() {
  const t = useT();
  const { client } = useServices();
  const closeToTray = useSettings((state) => state.settings.closeToTray);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .value((api) => api.window.isMaximized())
      .then((result) => {
        if (active && result.ok) setMaximized(result.data);
      });
    const unsubscribe = client.api.window.onMaximizedChange(setMaximized);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);

  const closeLabel = closeToTray ? t.t('ui.window.closeToTray') : t.t('ui.window.close');
  const maximizeLabel = maximized ? t.t('ui.window.restore') : t.t('ui.window.maximize');

  return (
    <div
      className="flex h-10 shrink-0 overflow-hidden rounded-md border border-border bg-input/70 shadow-inset"
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      role="group"
      aria-label={t.t('ui.window.controls')}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => client.api.window.minimize()}
        className={SEGMENT}
        aria-label={t.t('ui.window.minimize')}
        title={t.t('ui.window.minimize')}
      >
        <Minus className="size-[1.125rem]" strokeWidth={1.75} aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => client.api.window.toggleMaximize()}
        className={`${SEGMENT} border-l border-border`}
        aria-label={maximizeLabel}
        title={maximizeLabel}
      >
        {maximized ? (
          <Minimize2 className="size-[1.125rem]" strokeWidth={1.75} aria-hidden />
        ) : (
          <Maximize2 className="size-[1.125rem]" strokeWidth={1.75} aria-hidden />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => client.api.window.close()}
        className={`${SEGMENT} border-l border-border hover:bg-err/15 hover:text-err`}
        aria-label={closeLabel}
        title={closeToTray ? t.t('ui.window.closeToTrayHint') : closeLabel}
      >
        <X className="size-[1.125rem]" strokeWidth={1.75} aria-hidden />
      </Button>
    </div>
  );
}
