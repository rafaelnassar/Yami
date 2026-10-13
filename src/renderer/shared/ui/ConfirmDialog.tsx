import { useId, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './button.tsx';
import { Spinner } from './spinner.tsx';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './alert-dialog.tsx';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Destructive action: danger styling and the initial focus goes to Cancel. */
  danger?: boolean;
  /** Request in flight: buttons disabled, Esc ignored, spinner on confirm. */
  busy?: boolean;
  /** Extra controls (e.g. "also delete files" checkbox). */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation dialog composed on shadcn AlertDialog. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  children,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <AlertDialogContent
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border-2 bg-muted text-warn shadow-inset">
              <AlertTriangle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </span>
            <div className="min-w-0 space-y-2">
              <AlertDialogTitle id={titleId}>{title}</AlertDialogTitle>
              <AlertDialogDescription id={descriptionId}>{message}</AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        {children ? <div>{children}</div> : null}
        <AlertDialogFooter className="mt-2">
          <Button size="md" variant="ghost" autoFocus={danger} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            size="md"
            variant={danger ? 'destructive' : 'default'}
            autoFocus={!danger}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner className="h-4 w-4" /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
