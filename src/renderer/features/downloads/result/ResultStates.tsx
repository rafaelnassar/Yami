/** Empty / collecting / failed states and status banners for a conversation. */
import { AlertTriangle } from 'lucide-react';
import type { ConversationDetailDto } from '../../../../shared/contracts/dto.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { formatConversationEvent, formatOutcome } from '../../../shared/i18n/text.ts';
import type { ResultBanner } from './result-banner.ts';

export { resolveResultBanner, type ResultBanner } from './result-banner.ts';

export function CollectingState() {
  const t = useT();
  return (
    <div className="flex h-full min-h-28 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border-2 bg-input/30 px-5 text-center">
      <p className="m-0 text-sm font-medium text-text-2">{t.t('ui.result.collecting')}</p>
      <p className="m-0 text-xs leading-relaxed text-text-4">{t.t('ui.result.collectingHint')}</p>
    </div>
  );
}

export function FinishedWithoutMedia({ conversation }: { conversation: ConversationDetailDto }) {
  const t = useT();
  const summary = conversation.outcome ? formatOutcome(t, conversation.outcome) : (conversation.legacySummary ?? '');
  if (conversation.status === 'failed') {
    return (
      <div className="flex h-full min-h-24 items-start gap-3 rounded-md border border-err/25 bg-err/10 px-4 py-3.5">
        <AlertTriangle className="icon-inline mt-0.5 text-err" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0 space-y-1.5">
          <p className="m-0 text-sm font-medium text-err">{t.t('ui.result.failedTitle')}</p>
          <p className="m-0 break-words text-xs leading-relaxed text-text-2">
            {summary || t.t('ui.result.failedFallback')}
          </p>
          {conversation.outcome?.detail ? (
            <p
              className="m-0 break-all font-mono text-2xs leading-relaxed text-text-3"
              title={conversation.outcome.detail}
            >
              {conversation.outcome.detail}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-24 items-center justify-center rounded-md border border-border/60 bg-input/25 px-5 text-center">
      <p className="m-0 text-sm leading-relaxed text-text-4">{summary || t.t('ui.result.noMedia')}</p>
    </div>
  );
}

export function ResultAlert({ banner }: { banner: ResultBanner }) {
  const t = useT();
  const level = banner.kind === 'outcome' ? banner.level : banner.event.level === 'error' ? 'error' : 'warning';
  const text = banner.kind === 'outcome' ? formatOutcome(t, banner.outcome) : formatConversationEvent(t, banner.event);
  return (
    <div
      role="status"
      className={`flex shrink-0 items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs leading-relaxed ${
        level === 'error' ? 'border-err/20 bg-err/[0.08] text-err' : 'border-warn/20 bg-warn/[0.08] text-warn'
      }`}
    >
      <AlertTriangle className="icon-inline mt-0.5" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 flex-1 break-words" title={text}>
        {text}
      </span>
    </div>
  );
}
