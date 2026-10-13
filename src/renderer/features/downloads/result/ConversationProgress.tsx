/** Live progress of THIS conversation (from `state.downloads`, matched by conversation id). */
import { AnimatePresence, motion } from 'framer-motion';
import { Clock3, Loader2, Pause } from 'lucide-react';
import { useReducedMotion } from '../../../shared/hooks/useReducedMotion.ts';
import { truncateMiddle } from '../../../shared/i18n/format.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { DURATION, EASE_OUT_EXPO } from '../../../shared/lib/motion.ts';
import { baseName } from '../../../shared/lib/paths.ts';
import type { LiveProgress } from '../store/conversation-model.ts';

export function ConversationProgress({ live }: { live: LiveProgress }) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const running = live.kind === 'running' ? live : null;
  const paused = live.status === 'paused';
  const queued = live.kind === 'queued' && live.status === 'pending';

  const status = paused
    ? t.t('ui.progress.paused')
    : queued
      ? t.t('ui.progress.queued', { position: live.position })
      : t.t('ui.progress.downloading');
  const detail = running?.currentFile
    ? truncateMiddle(baseName(running.currentFile), 72)
    : queued
      ? t.t('ui.progress.waitingSlot')
      : t.t('ui.progress.preparing');
  const percent = running?.percent ?? null;
  const Icon = paused ? Pause : queued ? Clock3 : Loader2;
  const rounded = percent === null ? null : Math.round(percent);

  // Only the status word is a live region: announcing every file name and
  // percentage would flood screen readers several times per second.
  return (
    <div
      className={`download-activity flex min-w-0 flex-col gap-2 overflow-hidden rounded-md border px-3 py-2.5 ${paused ? 'border-warn/20 bg-surface/80' : 'border-border/80 bg-surface/80'}`}
      aria-busy={!paused || undefined}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md border ${paused ? 'border-warn/20 bg-warn/10 text-warn' : 'border-border bg-input/70 text-text-3'}`}
          aria-hidden
        >
          <Icon
            className={`size-[1.125rem] ${Icon === Loader2 ? 'animate-spin motion-reduce:animate-none' : ''}`}
            strokeWidth={Icon === Loader2 ? 2 : 1.75}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={`m-0 text-xs font-semibold ${paused ? 'text-warn' : 'text-text'}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {status}
          </p>
          <div className="relative mt-0.5 min-h-[1rem] overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={detail}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={{ duration: reduceMotion ? 0.01 : DURATION.fast, ease: EASE_OUT_EXPO }}
                className="m-0 truncate font-mono text-2xs text-text-3"
                title={running?.currentFile ?? detail}
              >
                {detail}
              </motion.p>
            </AnimatePresence>
          </div>
        </div>
        {running ? (
          <p className="m-0 shrink-0 font-mono text-2xs tabular-nums text-text-3">
            {t.t('ui.progress.counters', { done: running.done, skipped: running.skipped, errors: running.errors })}
          </p>
        ) : null}
      </div>
      {running && rounded !== null ? (
        <div className="flex items-center gap-3">
          <div
            className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full border border-border bg-input"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={rounded}
            aria-valuetext={t.t('ui.progress.fileProgressValue', { percent: rounded })}
            aria-label={t.t('ui.progress.fileProgress')}
          >
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-text-3 transition-[width] duration-300 ease-out motion-reduce:transition-none"
              style={{ width: `${Math.max(2, Math.min(100, rounded))}%` }}
            />
          </div>
          {running.speed || running.eta ? (
            <p className="m-0 flex shrink-0 gap-3 font-mono text-2xs tabular-nums text-text-3">
              {running.speed ? <span>{running.speed}</span> : null}
              {running.eta ? <span>{t.t('ui.progress.eta', { eta: running.eta })}</span> : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
