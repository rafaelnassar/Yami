import { useId, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useT } from '../i18n/i18n-context.tsx';
import { cn } from '../lib/utils.ts';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog.tsx';

export interface AppModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: LucideIcon;
  children: ReactNode;
  /** `md` forms · `lg` settings · `xl` logs. */
  size?: 'md' | 'lg' | 'xl';
  ariaLabel?: string;
  panelClassName?: string;
  bodyClassName?: string;
  /** Blocks Esc/backdrop close (e.g. while a request runs). */
  dismissible?: boolean;
}

const sizeClass = {
  md: 'max-w-lg',
  lg: 'max-w-3xl xl:max-w-4xl',
  xl: 'max-w-4xl xl:max-w-5xl'
} as const;

/** App shell dialog composed on shadcn Dialog (titlebar-aware overlay). */
export function AppModal({
  open,
  onClose,
  title,
  icon: Icon,
  children,
  size = 'lg',
  ariaLabel,
  panelClassName = '',
  bodyClassName = '',
  dismissible = true
}: AppModalProps) {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onClose();
      }}
    >
      <DialogContent
        hideClose
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-describedby={ariaLabel ? descriptionId : undefined}
        onEscapeKeyDown={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        className={cn(
          'max-h-[calc(100vh-4.5rem)] w-[calc(100%-2rem)] overflow-hidden p-0 sm:w-full',
          sizeClass[size],
          panelClassName
        )}
      >
        <DialogHeader>
          {Icon ? (
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/80 bg-input text-muted-foreground"
              aria-hidden
            >
              <Icon className="size-[1.125rem]" strokeWidth={1.75} />
            </span>
          ) : null}
          <DialogTitle id={titleId}>{title}</DialogTitle>
          {ariaLabel ? (
            <DialogDescription id={descriptionId} className="sr-only">
              {ariaLabel}
            </DialogDescription>
          ) : null}
          <DialogCloseButton
            className="ml-auto"
            onClick={() => {
              if (dismissible) onClose();
            }}
            disabled={!dismissible}
            aria-label={t.t('ui.common.close')}
            title={t.t('ui.common.close')}
          />
        </DialogHeader>
        <div
          className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4', bodyClassName)}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
