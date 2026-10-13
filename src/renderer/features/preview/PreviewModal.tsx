/**
 * Full-window media preview. Dialog layer (focus trap, Escape, focus restore);
 * arrows browse same-type siblings; media URLs come from `media.preview(path)`.
 */
import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, FolderOpen } from 'lucide-react';
import { usePreview, useServices } from '../../app/services-context.tsx';
import { useReducedMotion } from '../../shared/hooks/useReducedMotion.ts';
import { truncateMiddle } from '../../shared/i18n/format.ts';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { formatError } from '../../shared/i18n/text.ts';
import { isTypingTarget } from '../../shared/lib/focus.ts';
import { baseName } from '../../shared/lib/paths.ts';
import { Button } from '../../shared/ui/button.tsx';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogTitle } from '../../shared/ui/dialog.tsx';
import { useAdultBlur } from '../media/useAdultBlur.ts';
import { useMediaUrl } from '../media/useMediaUrl.ts';
import { PreviewContent, PreviewFallback, PreviewLoading } from './PreviewContent.tsx';
import { browseList, siblingOf } from './preview-store.ts';

export function PreviewModal() {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const { preview, actions } = useServices();
  const file = usePreview((state) => state.current);
  const scope = usePreview((state) => state.scope);
  const open = file !== null;
  const close = (): void => preview.getState().close();
  const media = useMediaUrl('preview', file?.path ?? null);
  const blur = useAdultBlur([file?.path, ...(file?.blurHints ?? [])]);
  const { items, index } = browseList(scope, file);
  const canBrowse = index >= 0 && items.length > 1;

  const go = (direction: 1 | -1): void => {
    const next = siblingOf(scope, file, direction);
    if (next) preview.getState().navigate(next);
  };

  useEffect(() => {
    if (!file || file.mediaType !== 'image') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target) || event.defaultPrevented) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const next = siblingOf(
          preview.getState().scope,
          preview.getState().current,
          event.key === 'ArrowLeft' ? -1 : 1
        );
        if (!next) return;
        event.preventDefault();
        preview.getState().navigate(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [file, preview]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        hideClose
        motion="fade"
        overlayClassName="bg-background/85"
        className="fixed bottom-0 left-0 right-0 top-[3.625rem] flex h-auto max-h-none w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none"
        aria-label={file ? t.t('ui.preview.dialogLabel', { name: file.name }) : undefined}
        onOpenAutoFocus={(event) => {
          // Prefer the close button (data-autofocus) over the first focusable.
          const target = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-autofocus]');
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        {file ? (
          <>
            <DialogTitle className="sr-only">{t.t('ui.preview.dialogLabel', { name: file.name })}</DialogTitle>
            <DialogDescription className="sr-only">{file.path}</DialogDescription>
            <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/95 p-3 px-4 md:px-5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground" title={file.path}>
                  {baseName(media.media?.name || file.name)}
                </div>
                <div className="truncate font-mono text-2xs text-text-3" title={file.path}>
                  {truncateMiddle(file.path, 80)}
                </div>
              </div>
              {canBrowse ? (
                <div className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-input/80 px-1 py-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="border-transparent"
                    onClick={() => go(-1)}
                    aria-label={t.t('ui.preview.previous')}
                    title={t.t('ui.preview.previous')}
                  >
                    <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                  </Button>
                  <span
                    className="min-w-[3.25rem] text-center font-mono text-2xs tabular-nums text-text-3"
                    aria-live="polite"
                  >
                    {t.t('ui.preview.position', { index: index + 1, total: items.length })}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="border-transparent"
                    onClick={() => go(1)}
                    aria-label={t.t('ui.preview.next')}
                    title={t.t('ui.preview.next')}
                  >
                    <ChevronRight className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                  </Button>
                </div>
              ) : null}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="border-transparent"
                onClick={() => void actions.files.revealFile(file.path)}
                aria-label={t.t('ui.result.openFolder')}
                title={t.t('ui.result.openFolderShort')}
              >
                <FolderOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </Button>
              <DialogCloseButton
                data-autofocus
                onClick={close}
                aria-label={t.t('ui.common.close')}
                title={t.t('ui.preview.closeHint')}
              />
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-contain" onClick={close}>
              {media.status === 'ready' ? (
                <PreviewContent
                  file={file}
                  media={media.media}
                  blur={blur}
                  reduceMotion={reduceMotion}
                  onOpenExternally={() => void actions.files.openFile(file.path)}
                  onClose={close}
                  onLoadError={media.reportLoadError}
                />
              ) : media.status === 'error' ? (
                <PreviewFallback
                  message={formatError(t, media.error)}
                  onOpenExternally={() => void actions.files.openFile(file.path)}
                />
              ) : (
                <PreviewLoading />
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
