/** "Link copied from <site>" chip; the URL text follows the adult-blur policy. */
import { ClipboardCheck, X } from 'lucide-react';
import type { ClipboardSuggestionDto } from '../../../shared/contracts/ipc.ts';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { Button } from '../../shared/ui/button.tsx';
import { SiteAvatar } from '../../shared/ui/SiteAvatar.tsx';
import { useAdultBlur } from '../media/useAdultBlur.ts';

export interface ClipboardSuggestionProps {
  readonly suggestion: ClipboardSuggestionDto;
  readonly applied: boolean;
  readonly onUse: (url: string) => void;
  readonly onDismiss: (url: string) => void;
}

export function ClipboardSuggestion({ suggestion, applied, onUse, onDismiss }: ClipboardSuggestionProps) {
  const t = useT();
  const blur = useAdultBlur([suggestion.url, suggestion.siteHost]);
  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-md border border-border bg-input/80 px-2.5 py-1.5 text-sm text-text-2"
      role="status"
    >
      <ClipboardCheck className="icon-inline text-text-3" strokeWidth={1.75} aria-hidden />
      <SiteAvatar sourceUrl={suggestion.url} size={16} />
      {blur.blurred ? (
        <Button
          type="button"
          variant="ghost"
          onClick={blur.reveal}
          className="h-auto min-h-0 min-w-0 flex-1 justify-start truncate border-0 bg-transparent px-0 py-0 text-left font-normal text-text-3 hover:bg-transparent"
          title={t.t('ui.nsfw.hiddenHint')}
        >
          <span className="select-none blur-[4px]" aria-hidden>
            {suggestion.siteHost}
          </span>
          <span className="sr-only">{t.t('ui.nsfw.revealLabel')}</span>
        </Button>
      ) : (
        <span className="min-w-0 flex-1 truncate" title={suggestion.url}>
          {t.t('ui.tray.suggestion', { site: suggestion.siteHost })}
        </span>
      )}
      {!applied ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onUse(suggestion.url)}
          className="shrink-0 font-medium text-text"
        >
          {t.t('ui.tray.useSuggestion')}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => onDismiss(suggestion.url)}
        className="shrink-0 text-text-3 hover:text-text"
        aria-label={t.t('ui.tray.dismissSuggestion')}
        title={t.t('ui.tray.dismissSuggestion')}
      >
        <X strokeWidth={1.75} aria-hidden />
      </Button>
    </div>
  );
}
