import { AnimatePresence, motion } from 'framer-motion';
import { FolderPlus, PanelLeftClose, Plus } from 'lucide-react';
import { ErrorBoundary } from '../../../app/ErrorBoundary.tsx';
import { useConversations, useFolders, useServices, useSettings, useUi } from '../../../app/services-context.tsx';
import { useReducedMotion } from '../../../shared/hooks/useReducedMotion.ts';
import { useFormat, useT } from '../../../shared/i18n/i18n-context.tsx';
import { DURATION, EASE_OUT_EXPO } from '../../../shared/lib/motion.ts';
import { Button } from '../../../shared/ui/button.tsx';
import { SidebarHistory } from './SidebarHistory.tsx';

/** Conversation history with folders; width comes from `settings.ui.sidebarWidth`. */
export function DownloadSidebar() {
  const t = useT();
  const format = useFormat();
  const reduceMotion = useReducedMotion();
  const { ui, actions } = useServices();
  const open = useUi((state) => state.sidebarOpen);
  const width = useSettings((state) => state.settings.ui.sidebarWidth);
  const count = useConversations((state) => state.items.length);
  const folderCount = useFolders((state) => state.folders.length);

  const openNewFolder = (): void => ui.getState().openDialog({ kind: 'edit-folder', folder: null });

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside
          initial={reduceMotion ? false : { width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { width: 0, opacity: 0 }}
          transition={{ duration: reduceMotion ? 0.01 : DURATION.medium, ease: EASE_OUT_EXPO }}
          className="download-sidebar shrink-0 overflow-hidden border-r border-border/80 bg-surface"
          aria-label={t.t('ui.sidebar.label')}
        >
          <div className="flex h-full flex-col" style={{ width }}>
            <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 pb-1 pt-2.5">
              <span className="type-nav-group m-0 px-0.5">{t.t('ui.sidebar.title')}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => ui.getState().setSidebarOpen(false)}
                className="text-text-3 hover:text-text"
                aria-label={t.t('ui.titlebar.sidebarHide')}
                title={t.t('ui.titlebar.sidebarHide')}
              >
                <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </Button>
            </div>

            <div className="shrink-0 border-b border-border/60 px-3 pb-2.5 pt-1">
              <Button
                type="button"
                variant="secondary"
                fullWidth
                onClick={() => actions.downloads.newDownload(null)}
                className="w-full justify-center gap-2.5 rounded-md border-border bg-input/40 px-3 hover:bg-input/70"
              >
                <Plus className="size-[1.125rem] text-text-3" strokeWidth={2} aria-hidden />
                {t.t('ui.sidebar.newDownload')}
              </Button>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-3">
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="type-nav-group m-0">{t.t('ui.sidebar.history')}</h2>
                <span className="font-mono text-2xs tabular-nums text-text-4">{format.number(count)}</span>
              </div>
              {folderCount > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  onClick={openNewFolder}
                  className="h-8 w-8 min-h-8 min-w-8 border-border/80 bg-input/50 text-text-2 hover:border-border-2 hover:bg-surface-2 hover:text-text"
                  aria-label={t.t('ui.sidebar.newFolder')}
                  title={t.t('ui.sidebar.newFolder')}
                >
                  <FolderPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                </Button>
              ) : null}
            </div>

            {folderCount === 0 ? (
              <div className="shrink-0 px-3 pb-2">
                <Button
                  type="button"
                  variant="ghost"
                  fullWidth
                  onClick={openNewFolder}
                  className="min-h-9 w-full justify-start gap-2 rounded-md border border-dashed border-border/90 bg-transparent px-2.5 text-xs font-medium text-text-3 hover:border-border-2 hover:bg-surface-2/70 hover:text-text-2"
                >
                  <FolderPlus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                  {t.t('ui.sidebar.newFolder')}
                </Button>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
              <ErrorBoundary>
                <SidebarHistory />
              </ErrorBoundary>
            </div>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
