import type { CSSProperties } from 'react';
import { Fish, Github, PanelLeftOpen, ScrollText, Settings } from 'lucide-react';
import { Button } from '../../shared/ui/button.tsx';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { useServices, useUi } from '../services-context.tsx';
import { WindowControls } from './WindowControls.tsx';

/** Public repository (not user-facing text). */
export const GITHUB_REPO_URL = 'https://github.com/rafaelnassar/Yami';

const ICON = 'h-5 w-5';
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

function actionClass(active: boolean): string {
  return `rounded-md border-transparent bg-transparent shadow-none ${
    active
      ? 'border-border-2 bg-surface-2 text-text'
      : 'text-text-3 hover:border-border hover:bg-surface-2 hover:text-text'
  }`;
}

/**
 * Frameless title bar: only the background is draggable; brand, actions and
 * window controls are `no-drag` regions.
 */
export function TitleBar() {
  const t = useT();
  const { ui, actions } = useServices();
  const sidebarOpen = useUi((state) => state.sidebarOpen);
  const settingsOpen = useUi((state) => state.panels.settings);
  const logsOpen = useUi((state) => state.panels.logs);

  return (
    <header
      className="relative z-[300] flex h-[3.625rem] shrink-0 select-none items-center gap-3 border-b border-border bg-surface/85 px-3.5 shadow-inset backdrop-blur-xl sm:gap-3.5 sm:px-4"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      <div className="flex shrink-0 items-center gap-2" style={NO_DRAG}>
        <Fish className="h-5 w-5 -rotate-45 text-text" strokeWidth={1.75} aria-hidden />
        <span className="type-brand">{t.t('ui.app.name')}</span>
      </div>

      {!sidebarOpen ? (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t.t('ui.titlebar.sidebarShow')}
          title={t.t('ui.titlebar.sidebarShow')}
          aria-expanded={false}
          className={actionClass(false)}
          style={NO_DRAG}
          onClick={() => ui.getState().setSidebarOpen(true)}
        >
          <PanelLeftOpen className={ICON} strokeWidth={1.75} aria-hidden />
        </Button>
      ) : null}

      <div className="min-w-8 flex-1" aria-hidden="true" />

      <nav className="flex shrink-0 items-center gap-1" style={NO_DRAG} aria-label={t.t('ui.titlebar.actions')}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t.t('ui.titlebar.settings')}
          title={t.t('ui.titlebar.settings')}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          className={actionClass(settingsOpen)}
          onClick={() => ui.getState().openPanel('settings')}
        >
          <Settings className={ICON} strokeWidth={1.75} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t.t('ui.titlebar.logs')}
          title={t.t('ui.titlebar.logs')}
          aria-haspopup="dialog"
          aria-expanded={logsOpen}
          className={actionClass(logsOpen)}
          onClick={() => ui.getState().openPanel('logs')}
        >
          <ScrollText className={ICON} strokeWidth={1.75} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t.t('ui.titlebar.github')}
          title={t.t('ui.titlebar.github')}
          className={actionClass(false)}
          onClick={() => void actions.files.openExternal(GITHUB_REPO_URL)}
        >
          <Github className={ICON} strokeWidth={1.75} aria-hidden />
        </Button>
      </nav>

      <div className="h-7 w-px shrink-0 bg-border" aria-hidden="true" />
      <WindowControls />
    </header>
  );
}
