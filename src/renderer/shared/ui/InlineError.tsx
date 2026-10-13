/** Inline load failure with the translated error and a Retry button (lists, panels, banners). */
import { AlertCircle, RotateCcw } from 'lucide-react';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { useT } from '../i18n/i18n-context.tsx';
import { formatError } from '../i18n/text.ts';
import { cn } from '../lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from './alert.tsx';
import { Button } from './button.tsx';
import { Spinner } from './spinner.tsx';

export interface InlineErrorProps {
  readonly title: string;
  readonly error: AppErrorData | null;
  readonly onRetry: () => void;
  readonly retrying?: boolean;
  /** Smaller variant for narrow places (sidebar, grid footers). */
  readonly compact?: boolean;
  readonly className?: string;
}

export function InlineError({
  title,
  error,
  onRetry,
  retrying = false,
  compact = false,
  className = ''
}: InlineErrorProps) {
  const t = useT();
  return (
    <Alert variant="destructive" className={cn(compact ? 'px-2.5 py-2' : 'px-3 py-2.5', className)}>
      <AlertCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      <AlertTitle className={cn('text-destructive', compact ? 'text-xs' : 'text-sm')}>{title}</AlertTitle>
      {error ? <AlertDescription>{formatError(t, error)}</AlertDescription> : null}
      <Button size="sm" variant="secondary" className="mt-2 px-2.5" onClick={onRetry} disabled={retrying}>
        {retrying ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        )}
        {t.t('ui.common.retry')}
      </Button>
    </Alert>
  );
}
