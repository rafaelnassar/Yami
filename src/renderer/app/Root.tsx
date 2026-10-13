/**
 * Renderer root: services, locale (from main's settings), motion preferences,
 * tooltip provider, root error boundary and view routing (main window | tray panel).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import type { AppView, YamiApi } from '../../shared/contracts/ipc.ts';
import { TrayQuickPanel } from '../features/tray/TrayQuickPanel.tsx';
import { I18nProvider } from '../shared/i18n/i18n-context.tsx';
import { browserScheduler } from '../shared/lib/scheduler.ts';
import { TooltipProvider } from '../shared/ui/tooltip.tsx';
import { startServices } from './bootstrap.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { MainShell } from './MainShell.tsx';
import { createServices } from './services.ts';
import { ServicesProvider, useSettings } from './services-context.tsx';

/**
 * Renders nothing (the dark body background) until main's settings arrive, so
 * the UI never flashes in the default language before switching to the saved
 * one. If loading fails, the defaults are used instead of waiting forever.
 */
function LocaleBridge({ children }: { children: ReactNode }) {
  const locale = useSettings((state) => state.settings.locale);
  const ready = useSettings((state) => state.loaded || state.loadError !== null);
  if (!ready) return null;
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}

export function Root({ api, view }: { api: YamiApi; view: AppView }) {
  const [services] = useState(() => createServices(api, browserScheduler));

  useEffect(() => startServices(services, view), [services, view]);

  return (
    <ServicesProvider services={services}>
      <LocaleBridge>
        <MotionConfig reducedMotion="user">
          <TooltipProvider delayDuration={400}>
            <ErrorBoundary variant="root">{view === 'tray' ? <TrayQuickPanel /> : <MainShell />}</ErrorBoundary>
          </TooltipProvider>
        </MotionConfig>
      </LocaleBridge>
    </ServicesProvider>
  );
}
