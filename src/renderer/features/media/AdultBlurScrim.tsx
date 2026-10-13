import { EyeOff } from 'lucide-react';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { Button } from '../../shared/ui/button.tsx';

/**
 * Overlay shown over blurred media. It is a full-area control placed as a sibling
 * of the media's own action (never nested inside another interactive element).
 */
export function AdultBlurScrim({ onReveal, compact = false }: { onReveal: () => void; compact?: boolean }) {
  const t = useT();
  return (
    <Button
      type="button"
      variant="ghost"
      className="absolute inset-0 z-[5] flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 rounded-none border-0 bg-bg/40 px-3 text-center font-normal hover:bg-bg/50"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onReveal();
      }}
      aria-label={t.t('ui.nsfw.revealLabel')}
      title={t.t('ui.nsfw.hiddenHint')}
    >
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/70 bg-bg/90 text-text-2">
        <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      </span>
      {compact ? null : <span className="text-2xs font-medium tracking-wide text-text-2">{t.t('ui.nsfw.reveal')}</span>}
    </Button>
  );
}
