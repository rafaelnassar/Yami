import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils.ts';

/** Top-of-page chrome: stable typography + spacing across routes (do not resize in pages). */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex flex-col gap-3 border-b border-border/70 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        className
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? <div className="type-caption m-0 text-text-4">{eyebrow}</div> : null}
        <h1 className="type-page m-0 min-w-0 truncate">{title}</h1>
        {description ? <p className="type-body m-0 max-w-prose text-text-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 pt-0.5">{actions}</div> : null}
    </header>
  );
}

/** In-page section title (below PageHeader or inside panels). */
export function SectionHeader({
  title,
  description,
  actions,
  className
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3', className)}>
      <div className="min-w-0 space-y-1">
        <h2 className="type-heading m-0">{title}</h2>
        {description ? <p className="type-caption m-0 max-w-prose">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
