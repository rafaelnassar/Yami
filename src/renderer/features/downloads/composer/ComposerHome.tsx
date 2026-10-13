/**
 * Home view: rotating greeting above the composer, vertically centred in the
 * workspace (the dock is anchored at the bottom and translated up).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { UI_GREETINGS } from '../../../../shared/i18n/messages/ui.ts';
import { useComposer } from '../../../app/services-context.tsx';
import { useReducedMotion } from '../../../shared/hooks/useReducedMotion.ts';
import { useLocale } from '../../../shared/i18n/i18n-context.tsx';
import {
  composerExit,
  DURATION,
  EASE_IN_EXPO,
  EASE_OUT_EXPO,
  FLOAT_LAYER_CLASS,
  motionDuration,
  SPRING
} from '../../../shared/lib/motion.ts';
import { Composer } from './Composer.tsx';
import { pickGreeting } from './composer-model.ts';
import { useComposerController } from './useComposer.ts';
import { useComposerGlow } from './useComposerGlow.ts';

export const COMPOSER_MAX = 'min(96vw,1080px)';

export function ComposerHome({ workspaceRef }: { workspaceRef: RefObject<HTMLElement> }) {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const controller = useComposerController();
  const promptRevision = useComposer((state) => state.promptRevision);
  const dockRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [offsetY, setOffsetY] = useState(0);
  const glow = useComposerGlow(true, reduceMotion);

  const [greeting, setGreeting] = useState(() => ({
    revision: promptRevision,
    locale,
    text: pickGreeting(UI_GREETINGS[locale], null)
  }));
  if (greeting.revision !== promptRevision || greeting.locale !== locale) {
    setGreeting({ revision: promptRevision, locale, text: pickGreeting(UI_GREETINGS[locale], greeting.text) });
  }

  const measure = useCallback(() => {
    const workspace = workspaceRef.current;
    const dock = dockRef.current;
    if (workspace && dock) setOffsetY(-(workspace.clientHeight - dock.offsetHeight) / 2);
  }, [workspaceRef]);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (workspaceRef.current) observer.observe(workspaceRef.current);
    if (dockRef.current) observer.observe(dockRef.current);
    return () => observer.disconnect();
  }, [measure, workspaceRef]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [promptRevision, controller.mode]);

  return (
    <motion.div
      key="composer-home"
      ref={dockRef}
      className={`download-composer-dock pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4 pt-2 sm:px-8 sm:pb-5 lg:px-10 ${FLOAT_LAYER_CLASS}`}
      initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: offsetY, scale: 1 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: 0.01 } }
          : {
              ...composerExit(false),
              transition: {
                opacity: { duration: DURATION.fast, ease: EASE_IN_EXPO },
                scale: { duration: DURATION.fast, ease: EASE_IN_EXPO }
              }
            }
      }
      transition={
        reduceMotion
          ? { duration: 0.01 }
          : {
              opacity: { duration: DURATION.slow, ease: EASE_OUT_EXPO },
              scale: { duration: DURATION.slow, ease: EASE_OUT_EXPO },
              y: SPRING.shell
            }
      }
    >
      <div
        className="download-hero download-hero--idle pointer-events-auto relative mx-auto w-full"
        style={{ maxWidth: COMPOSER_MAX }}
      >
        <AnimatePresence initial={false} mode="wait">
          <motion.header
            key={greeting.text}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: motionDuration(reduceMotion, DURATION.fast), ease: EASE_OUT_EXPO }}
            className="mb-4 text-center sm:mb-5"
          >
            <h1 className="type-page m-0 text-balance">{greeting.text}</h1>
          </motion.header>
        </AnimatePresence>
        <Composer
          controller={controller}
          inputRef={inputRef}
          glowClass={glow.glowClass}
          onGlowAnimationEnd={glow.onAnimationEnd}
        />
      </div>
    </motion.div>
  );
}
