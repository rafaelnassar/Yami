/**
 * Motion design tokens — one identity for the whole UI.
 * Prefer opacity + transform; avoid animating layout properties or filters
 * (they cause blur/flicker on menus and overlays in Electron).
 */

/** Main curve (entering / overlays). */
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

/** Slightly faster, firmer exit. */
export const EASE_IN_EXPO = [0.7, 0, 0.84, 0] as const;

export const DURATION = {
  micro: 0.15,
  fast: 0.16,
  short: 0.2,
  medium: 0.22,
  slow: 0.28,
  /** Toast auto-dismiss (ms). */
  toastMs: 4200,
  toastSuccessMs: 3600
} as const;

export const SPRING = {
  shell: { type: 'spring' as const, stiffness: 300, damping: 30, mass: 0.86 },
  press: { type: 'spring' as const, stiffness: 520, damping: 32, mass: 0.7 }
} as const;

export function motionDuration(reduceMotion: boolean, seconds: number): number {
  return reduceMotion ? 0.01 : seconds;
}

export const overlayFade = (reduceMotion: boolean) => ({
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: motionDuration(reduceMotion, DURATION.short), ease: EASE_OUT_EXPO }
});

export const modalPanel = (reduceMotion: boolean) => ({
  initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 },
  animate: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 },
  exit: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.985 },
  transition: { duration: motionDuration(reduceMotion, DURATION.medium), ease: EASE_OUT_EXPO }
});

/** Popover / dropdown / menu. Minimum scale (0.98) avoids sub-pixel blur. */
export const popoverMotion = (reduceMotion: boolean, origin: 'bottom' | 'top' = 'bottom') => {
  const yEnter = origin === 'bottom' ? 6 : -6;
  return {
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: yEnter, scale: 0.98 },
    animate: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, y: yEnter * 0.6, scale: 0.98 },
    transition: { duration: motionDuration(reduceMotion, DURATION.fast), ease: EASE_OUT_EXPO }
  };
};

export const toastMotion = (reduceMotion: boolean) => ({
  initial: reduceMotion ? { opacity: 0 } : { opacity: 0, x: 14, y: -4, scale: 0.98 },
  animate: reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, y: 0, scale: 1 },
  exit: reduceMotion ? { opacity: 0 } : { opacity: 0, x: 10, scale: 0.98 },
  transition: { duration: motionDuration(reduceMotion, DURATION.short), ease: EASE_OUT_EXPO }
});

export const composerExit = (reduceMotion: boolean) => (reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 });

/** Utility class for floating layers (avoids compositing flicker). */
export const FLOAT_LAYER_CLASS = 'transform-gpu will-change-transform [backface-visibility:hidden]';
