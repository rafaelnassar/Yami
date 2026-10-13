import type { AnimationEvent, MutableRefObject } from 'react';
import { ArrowUp, ClipboardPaste } from 'lucide-react';
import { LIMITS } from '../../../../shared/contracts/host-protocol.ts';
import { useComposer, useFolders, useHost, useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { Label } from '../../../shared/ui/label.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';
import { ComposerModeMenu } from './ComposerModeMenu.tsx';
import { FolderPicker } from './FolderPicker.tsx';
import type { ComposerController } from './useComposer.ts';

export interface ComposerProps {
  readonly controller: ComposerController;
  readonly glowClass: string;
  readonly inputRef: MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  readonly onGlowAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => void;
}

const INPUT_ID = 'yami-download-input';
const HELP_ID = 'yami-composer-help';

/** The link input with its toolbar (mode/engine, folder, paste, start). */
export function Composer({ controller: c, glowClass, inputRef, onGlowAnimationEnd }: ComposerProps) {
  const t = useT();
  const { composer, host } = useServices();
  const folders = useFolders((state) => state.folders);
  const pendingFolderId = useComposer((state) => state.pendingFolderId);
  const connection = useHost((state) => state.connection.state);
  const pendingFolder = folders.find((folder) => folder.id === pendingFolderId) ?? null;
  const offline = connection === 'offline';

  const singleInvalid = c.mode === 'single' && c.urlDraft.trim().length > 0 && !c.singleValid;
  const showHelp = c.mode === 'bulk' || singleInvalid;
  const helpIsError = singleInvalid || (c.mode === 'bulk' && (c.batch.invalid > 0 || c.batch.overLimit));
  const helpText =
    c.mode === 'single'
      ? t.t('ui.composer.help.single')
      : c.batch.overLimit
        ? t.t('ui.composer.help.overLimit', { max: LIMITS.maxUrlsPerBatch })
        : c.batch.invalid > 0
          ? t.t('ui.composer.help.invalid', { count: c.batch.invalid })
          : t.t('ui.composer.help.batch', { count: c.batch.urls.length });
  const submitLabel = c.mode === 'single' ? t.t('ui.composer.start') : t.t('ui.composer.startBatch');

  return (
    <>
      <div
        className={`download-composer border border-border bg-surface ${glowClass} rounded-lg p-2.5 transition-[border-color] duration-200 focus-within:border-focus`}
        onAnimationEnd={onGlowAnimationEnd}
      >
        <Label htmlFor={INPUT_ID} className="sr-only">
          {c.mode === 'single' ? t.t('ui.composer.label.single') : t.t('ui.composer.label.bulk')}
        </Label>
        {c.mode === 'single' ? (
          <input
            ref={(element) => {
              inputRef.current = element;
            }}
            id={INPUT_ID}
            type="url"
            value={c.urlDraft}
            onChange={(event) => c.setUrlDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                c.submit();
              }
            }}
            placeholder={t.t('ui.composer.placeholder.single')}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={singleInvalid}
            aria-describedby={showHelp ? HELP_ID : undefined}
            className="min-h-[42px] w-full border-0 bg-transparent px-3 pb-1.5 pt-1.5 font-sans text-sm text-text outline-none placeholder:text-text-4 focus:outline-none"
          />
        ) : (
          <textarea
            ref={(element) => {
              inputRef.current = element;
            }}
            id={INPUT_ID}
            value={c.batchDraft}
            onChange={(event) => c.setBatchDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                c.submit();
              }
            }}
            placeholder={t.t('ui.composer.placeholder.bulk')}
            spellCheck={false}
            aria-invalid={helpIsError}
            aria-describedby={HELP_ID}
            className="max-h-52 min-h-28 w-full resize-y border-0 bg-transparent px-3 pb-2 pt-1.5 font-mono text-sm leading-6 text-text outline-none placeholder:font-sans placeholder:text-text-4 focus:outline-none"
          />
        )}

        <div
          className={`composer-toolbar grid items-end gap-2 ${offline ? 'grid-cols-[minmax(0,1fr)_auto_auto]' : 'grid-cols-[minmax(0,1fr)_auto]'}`}
        >
          <div className="flex min-w-0 items-center gap-1">
            <ComposerModeMenu
              mode={c.mode}
              engine={c.engine}
              missing={c.missingEngines}
              onModeChange={c.setMode}
              onEngineChange={c.setEngine}
            />
            {folders.length > 0 ? (
              <FolderPicker
                folders={folders}
                selected={pendingFolder}
                onChange={(id) => composer.getState().setPendingFolder(id)}
              />
            ) : null}
          </div>

          {offline ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void host.getState().restart()}
              className="composer-status inline-flex min-h-9 min-w-0 items-center gap-2 border-transparent px-2 text-xs font-normal text-text-3 hover:text-text"
              title={t.t('ui.composer.status.offlineTitle')}
              aria-label={`${t.t('ui.composer.status.offline')}. ${t.t('ui.composer.status.offlineTitle')}`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-err" aria-hidden />
              <span className="composer-status-label font-medium text-text-2">{t.t('ui.composer.status.offline')}</span>
            </Button>
          ) : null}

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void c.paste()}
              className="text-text-3 hover:text-text"
              title={t.t('ui.composer.paste')}
              aria-label={t.t('ui.composer.paste')}
            >
              <ClipboardPaste className="size-[1.125rem]" strokeWidth={1.75} aria-hidden />
            </Button>
            <Button
              type="button"
              variant="primary"
              size="icon"
              onClick={c.submit}
              disabled={!c.canSubmit}
              title={submitLabel}
              aria-label={submitLabel}
            >
              {c.starting ? (
                <Spinner className="size-[1.125rem]" />
              ) : (
                <ArrowUp className="size-[1.125rem]" strokeWidth={1.75} aria-hidden />
              )}
            </Button>
          </div>
        </div>
      </div>

      {showHelp ? (
        <div id={HELP_ID} className="mt-2.5 min-h-5 px-1">
          <p className={`m-0 text-xs ${helpIsError ? 'text-err' : 'text-text-4'}`} role="status" aria-live="polite">
            {helpText}
          </p>
        </div>
      ) : null}
    </>
  );
}
