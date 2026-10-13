/**
 * Main area: the open conversation, or the home composer when none is open.
 */
import { useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RotateCcw } from 'lucide-react';
import { useActiveConversation, useServices } from '../../../app/services-context.tsx';
import { ErrorBoundary } from '../../../app/ErrorBoundary.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { useReducedMotion } from '../../../shared/hooks/useReducedMotion.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { formatError } from '../../../shared/i18n/text.ts';
import {
  DURATION,
  EASE_IN_EXPO,
  EASE_OUT_EXPO,
  FLOAT_LAYER_CLASS,
  motionDuration
} from '../../../shared/lib/motion.ts';
import { COMPOSER_MAX, ComposerHome } from '../composer/ComposerHome.tsx';
import { ResultCard } from '../result/ResultCard.tsx';

function ConversationView() {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const id = useActiveConversation((state) => state.id);
  const conversation = useActiveConversation((state) => state.conversation);
  const files = useActiveConversation((state) => state.files);
  const error = useActiveConversation((state) => state.error);
  const loading = useActiveConversation((state) => state.loading);
  const { active } = useServices();

  return (
    <motion.div
      key="conversation"
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: motionDuration(reduceMotion, DURATION.medium), ease: EASE_IN_EXPO } }}
      className="absolute inset-0 z-20 flex min-h-0 flex-col overflow-hidden bg-bg"
    >
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: motionDuration(reduceMotion, DURATION.slow), ease: EASE_OUT_EXPO }}
        className={`flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3 sm:px-6 sm:py-4 lg:px-8 ${FLOAT_LAYER_CLASS}`}
      >
        <div className="mx-auto flex h-full min-h-0 w-full flex-col" style={{ maxWidth: COMPOSER_MAX }}>
          <ErrorBoundary resetKey={id}>
            {conversation && conversation.id === id ? (
              <div className="result-workspace">
                <ResultCard conversation={conversation} files={files} />
              </div>
            ) : error && !loading ? (
              <div className="result-workspace items-center justify-center gap-3 text-center" role="alert">
                <p className="type-heading m-0">{t.t('ui.session.toast.conversationUnavailable')}</p>
                <p className="type-caption m-0 max-w-md">{formatError(t, error)}</p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void active.getState().reload()}
                  className="gap-2 px-4"
                >
                  <RotateCcw className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                  {t.t('ui.common.retry')}
                </Button>
              </div>
            ) : (
              <div className="result-workspace" role="status" aria-label={t.t('ui.composer.loadingConversation')}>
                <div className="h-full min-h-0 animate-pulse rounded-lg border border-border-2 bg-surface-2/40 motion-reduce:animate-none" />
              </div>
            )}
          </ErrorBoundary>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function DownloadWorkspace() {
  const workspaceRef = useRef<HTMLElement>(null);
  const hasConversation = useActiveConversation((state) => state.id !== null);

  return (
    <main
      ref={workspaceRef}
      className="download-workspace relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <AnimatePresence initial={false}>
        {hasConversation ? <ConversationView key="conversation" /> : null}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {!hasConversation ? <ComposerHome key="home" workspaceRef={workspaceRef} /> : null}
      </AnimatePresence>
    </main>
  );
}
