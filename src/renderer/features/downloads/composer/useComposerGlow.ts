/**
 * Idle glow of the home composer: expands once on entering the home view, then
 * breathes. Reduced motion jumps straight to the static lit state.
 */
import { useCallback, useEffect, useState, type AnimationEvent } from 'react';

export function useComposerGlow(
  active: boolean,
  reduceMotion: boolean
): { readonly glowClass: string; readonly onAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => void } {
  const [phase, setPhase] = useState<'off' | 'enter' | 'lit'>('off');

  useEffect(() => {
    if (!active) {
      setPhase('off');
      return;
    }
    setPhase(reduceMotion ? 'lit' : 'enter');
  }, [active, reduceMotion]);

  useEffect(() => {
    if (phase !== 'enter') return;
    const timer = window.setTimeout(() => setPhase('lit'), 2500);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const onAnimationEnd = useCallback((event: AnimationEvent<HTMLDivElement>) => {
    if (event.animationName === 'idle-composer-glow-expand') setPhase('lit');
  }, []);

  const glowClass =
    phase === 'enter' ? 'download-composer--glow-enter' : phase === 'lit' ? 'download-composer--glow-lit' : '';
  return { glowClass, onAnimationEnd };
}
