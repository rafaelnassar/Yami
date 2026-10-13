/** Auto-hides the player chrome after a short idle period while playing. */
import { useCallback, useEffect, useRef, useState } from 'react';

const IDLE_MS = 2200;
const LEAVE_MS = 500;

export interface ControlsVisibility {
  readonly visible: boolean;
  /** Shows the chrome and restarts the idle timer. */
  readonly reveal: () => void;
  /** Keeps the chrome visible (hovered, dragging, menu open). */
  readonly hold: (key: 'hover' | 'drag' | 'menu', active: boolean) => void;
  readonly leave: () => void;
}

export function useControlsVisibility(playing: boolean, disabled: boolean): ControlsVisibility {
  const [visible, setVisible] = useState(true);
  const timer = useRef(0);
  const holds = useRef(new Set<string>());
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
  }, []);

  const schedule = useCallback(
    (ms: number) => {
      clear();
      if (disabled || !playingRef.current || holds.current.size > 0) return;
      timer.current = window.setTimeout(() => setVisible(false), ms);
    },
    [clear, disabled]
  );

  const reveal = useCallback(() => {
    setVisible(true);
    schedule(IDLE_MS);
  }, [schedule]);

  useEffect(() => {
    if (!playing) {
      clear();
      setVisible(true);
      return;
    }
    schedule(IDLE_MS);
  }, [clear, playing, schedule]);

  useEffect(() => clear, [clear]);

  return {
    visible,
    reveal,
    hold(key, active) {
      if (active) {
        holds.current.add(key);
        clear();
        setVisible(true);
      } else {
        holds.current.delete(key);
        schedule(IDLE_MS);
      }
    },
    leave() {
      holds.current.delete('hover');
      schedule(LEAVE_MS);
    }
  };
}
