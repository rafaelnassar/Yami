/**
 * Composer controller: drafts, validation, engine/scope preferences (app
 * settings), clipboard paste and submission.
 */
import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AppSettingsPatch } from '../../../../shared/contracts/app-settings.ts';
import { ENGINES, type DownloadScope, type Engine } from '../../../../shared/domain/engine.ts';
import { isHttpUrl } from '../../../../shared/domain/url.ts';
import { useComposer as useComposerStore, useHost, useServices, useSettings } from '../../../app/services-context.tsx';
import { isHostReady } from '../../host/host-store.ts';
import { errorText, key } from '../../notices/notices-store.ts';
import { appendToBatch, canSubmitBatch, checkBatch, type BatchCheck } from './composer-model.ts';

export interface ComposerController {
  readonly mode: DownloadScope;
  readonly engine: Engine;
  readonly urlDraft: string;
  readonly batchDraft: string;
  readonly batch: BatchCheck;
  readonly singleValid: boolean;
  readonly canSubmit: boolean;
  readonly starting: boolean;
  readonly missingEngines: ReadonlySet<Engine>;
  readonly setUrlDraft: (value: string) => void;
  readonly setBatchDraft: (value: string) => void;
  readonly setMode: (mode: DownloadScope) => void;
  readonly setEngine: (engine: Engine) => void;
  readonly paste: () => Promise<void>;
  readonly submit: () => void;
}

export function useComposerController(): ComposerController {
  const services = useServices();
  const mode = useComposerStore((state) => state.mode);
  const urlDraft = useComposerStore((state) => state.urlDraft);
  const batchDraft = useComposerStore((state) => state.batchDraft);
  const starting = useComposerStore((state) => state.starting > 0);
  const composerEngine = useSettings((state) => state.settings.ui.composerEngine);
  // Primitive list compared shallowly: host snapshots (4×/s) carry new `engines` objects every time.
  const missingList = useHost(
    useShallow((state) => ENGINES.filter((item) => state.state !== null && !state.state.engines[item].available))
  );
  const hostReady = useHost(isHostReady);

  const engine = composerEngine[mode];
  const missingEngines = useMemo<ReadonlySet<Engine>>(() => new Set(missingList), [missingList]);

  const batch = useMemo(() => checkBatch(batchDraft), [batchDraft]);
  const trimmed = urlDraft.trim();
  const singleValid = isHttpUrl(trimmed);
  const canSubmit =
    hostReady && !starting && !missingEngines.has(engine) && (mode === 'single' ? singleValid : canSubmitBatch(batch));

  // Sticky warning (with a shortcut to Settings) while the selected engine is missing.
  const engineMissing = hostReady && missingEngines.has(engine);
  useEffect(() => {
    const notices = services.notices.getState();
    for (const item of ['gallery-dl', 'yt-dlp'] as const) {
      if (item !== engine || !engineMissing) notices.remove(`engine-missing-${item}`);
    }
    if (!engineMissing) return;
    notices.push({
      id: `engine-missing-${engine}`,
      kind: 'warn',
      title: key(engine === 'gallery-dl' ? 'ui.engine.galleryMissingTitle' : 'ui.engine.videoMissingTitle'),
      message: key('ui.engine.missingMessage'),
      action: { type: 'open-settings' },
      sticky: true,
      rememberDismissal: true
    });
  }, [engine, engineMissing, services.notices]);

  const composer = services.composer.getState();
  const saveSetting = (patch: AppSettingsPatch): void => {
    void services.settings
      .getState()
      .update(patch)
      .then((error) => {
        if (error)
          services.notices
            .getState()
            .push({ kind: 'error', title: key('ui.settings.saveFail'), message: errorText(error) });
      });
  };

  return {
    mode,
    engine,
    urlDraft,
    batchDraft,
    batch,
    singleValid,
    canSubmit,
    starting,
    missingEngines,
    setUrlDraft: composer.setUrlDraft,
    setBatchDraft: composer.setBatchDraft,
    setMode(next) {
      composer.setMode(next);
      saveSetting({ ui: { composerScope: next } });
    },
    setEngine(next) {
      saveSetting({ ui: { composerEngine: { ...composerEngine, [mode]: next } } });
    },
    async paste() {
      const result = await services.client.value((api) => api.clipboard.readUrls());
      if (!result.ok || result.data.length === 0) return;
      if (mode === 'single') composer.setUrlDraft(result.data[0] ?? '');
      else composer.setBatchDraft(appendToBatch(services.composer.getState().batchDraft, result.data));
    },
    submit() {
      if (!canSubmit) return;
      const urls = mode === 'single' ? [trimmed] : batch.urls;
      void services.actions.downloads.start(urls, engine, mode);
    }
  };
}
