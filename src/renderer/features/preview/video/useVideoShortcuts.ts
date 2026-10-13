/**
 * Player keyboard shortcuts (capture phase, so the preview's arrow navigation
 * and the modal Escape do not fire while the player handles the key):
 * Space/K play, J/← −10 s, L/→ +10 s, ↑/↓ volume, M mute, F fullscreen, Home/End.
 */
import { useEffect, useRef } from 'react';
import { isTypingTarget } from '../../../shared/lib/focus.ts';
import { SKIP_SECONDS, VOLUME_STEP, VOLUME_STEP_FINE } from './MediaSlider.tsx';

export interface ShortcutHandlers {
  readonly enabled: boolean;
  readonly volume: number;
  readonly muted: boolean;
  readonly duration: number;
  readonly rememberedVolume: number;
  /** Returns true when it consumed Escape (speed menu or fullscreen open). */
  readonly onEscape: () => boolean;
  readonly togglePlayback: () => void;
  readonly skipBy: (seconds: number) => void;
  readonly setVolume: (volume: number) => void;
  readonly toggleMute: () => void;
  readonly toggleFullscreen: () => void;
  readonly seekTo: (time: number) => void;
  readonly reveal: () => void;
}

export function useVideoShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const h = ref.current;
      if (!h.enabled || isTypingTarget(event.target) || document.querySelector('[role="alertdialog"]')) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === 'Escape') {
        if (h.onEscape()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="menu"]')) return;
      if (
        target?.closest('[data-media-slider]') &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)
      )
        return;
      if (target?.tagName === 'BUTTON' && (key === ' ' || key === 'Enter')) return;

      const act = (run: () => void): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
        run();
        h.reveal();
      };
      const step = event.shiftKey ? VOLUME_STEP_FINE : VOLUME_STEP;
      switch (key) {
        case ' ':
        case 'k':
          return act(h.togglePlayback);
        case 'ArrowLeft':
        case 'j':
          return act(() => h.skipBy(-SKIP_SECONDS));
        case 'ArrowRight':
        case 'l':
          return act(() => h.skipBy(SKIP_SECONDS));
        case 'ArrowUp':
          return act(() => h.setVolume(h.muted ? h.rememberedVolume || step : h.volume + step));
        case 'ArrowDown':
          return act(() => h.setVolume((h.muted ? 0 : h.volume) - step));
        case 'm':
          return act(h.toggleMute);
        case 'f':
          return act(h.toggleFullscreen);
        case 'Home':
          return act(() => h.seekTo(0));
        case 'End':
          return act(() => h.seekTo(h.duration));
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
