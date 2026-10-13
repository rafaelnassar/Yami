/**
 * Tray quick-panel controller: URL prefill on show (clipboard suggestion or
 * clipboard URL), engine preference (`settings.ui.trayEngine`), submission and
 * auto-hide. The host state arrives through the same broadcast events as the
 * main window, so no `session.init` round-trip is needed on every show.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ClipboardSuggestionDto } from '../../../shared/contracts/ipc.ts';
import type { Engine } from '../../../shared/domain/engine.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { useHost, useServices, useSettings } from '../../app/services-context.tsx';
import { isHostReady } from '../host/host-store.ts';
import { canSubmitTray, trayStatus, type TrayPhase, type TrayStatus } from './tray-model.ts';

const HIDE_AFTER_OK_MS = 700;
const FOCUS_DELAY_MS = 40;

export interface TrayPanel {
  readonly url: string;
  readonly engine: Engine;
  readonly phase: TrayPhase;
  readonly error: AppErrorData | null;
  readonly status: TrayStatus;
  readonly canSubmit: boolean;
  readonly suggestion: ClipboardSuggestionDto | null;
  readonly confirmQuit: boolean;
  readonly setUrl: (url: string) => void;
  readonly setEngine: (engine: Engine) => void;
  readonly setConfirmQuit: (value: boolean) => void;
  readonly paste: () => Promise<void>;
  readonly submit: () => Promise<void>;
  readonly dismissSuggestion: (url: string) => void;
  readonly hide: () => void;
}

export function useTrayPanel(inputRef: RefObject<HTMLInputElement>): TrayPanel {
  const { client, settings } = useServices();
  const api = client.api;
  const engine = useSettings((state) => state.settings.ui.trayEngine);
  const ready = useHost(isHostReady);
  const engineAvailable = useHost((state) => state.state?.engines[engine].available ?? true);
  const [url, setUrlState] = useState('');
  const [phase, setPhase] = useState<TrayPhase>('idle');
  const [error, setError] = useState<AppErrorData | null>(null);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [suggestion, setSuggestion] = useState<ClipboardSuggestionDto | null>(null);
  // Written by the listeners themselves: `shown` can fire right after a suggestion,
  // before React re-rendered with the new state.
  const suggestionRef = useRef<ClipboardSuggestionDto | null>(null);
  const timers = useRef<number[]>([]);

  const focusInput = useCallback(() => {
    timers.current.push(
      window.setTimeout(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }, FOCUS_DELAY_MS)
    );
  }, [inputRef]);

  useEffect(() => {
    const offSuggestion = api.tray.onClipboardSuggestion((next) => {
      suggestionRef.current = next;
      setSuggestion(next);
      if (next) setUrlState((current) => (current.trim() ? current : next.url));
    });
    const offShown = api.tray.onShown(() => {
      setPhase('idle');
      setError(null);
      setConfirmQuit(false);
      const suggested = suggestionRef.current?.url ?? null;
      if (suggested) {
        setUrlState(suggested);
        focusInput();
        return;
      }
      void client
        .value((bridge) => bridge.clipboard.readUrls())
        .then((result) => {
          // Fresh start on every show: stale drafts from a previous opening are dropped.
          setUrlState(result.ok ? (result.data[0] ?? '') : '');
          focusInput();
        });
    });
    const pending = timers.current;
    return () => {
      offSuggestion();
      offShown();
      for (const id of pending) window.clearTimeout(id);
    };
  }, [api, client, focusInput]);

  const input = { phase, ready, engineAvailable, url };

  return {
    url,
    engine,
    phase,
    error,
    status: trayStatus(input),
    canSubmit: canSubmitTray(input),
    suggestion,
    confirmQuit,
    setUrl(next) {
      setUrlState(next);
      if (phase === 'error' || phase === 'ok') setPhase('idle');
    },
    setEngine(next) {
      void settings
        .getState()
        .update({ ui: { trayEngine: next } })
        .then((failure) => {
          if (!failure) return;
          setPhase('error');
          setError(failure);
        });
    },
    setConfirmQuit,
    async paste() {
      const result = await client.value((bridge) => bridge.clipboard.readUrls());
      if (result.ok && result.data[0]) setUrlState(result.data[0]);
      inputRef.current?.focus({ preventScroll: true });
    },
    async submit() {
      if (!canSubmitTray(input)) return;
      setPhase('starting');
      setError(null);
      const result = await client.request('downloads.start', { urls: [url.trim()], engine, scope: 'single' });
      if (!result.ok) {
        setPhase('error');
        setError(result.error);
        return;
      }
      setPhase('ok');
      setUrlState('');
      timers.current.push(
        window.setTimeout(() => {
          api.tray.hide();
          setPhase('idle');
        }, HIDE_AFTER_OK_MS)
      );
    },
    dismissSuggestion(target) {
      api.tray.dismissSuggestion(target);
      suggestionRef.current = null;
      setSuggestion(null);
    },
    hide: () => api.tray.hide()
  };
}
