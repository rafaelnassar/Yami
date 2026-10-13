import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils.ts';
import { Button, type ButtonProps } from '@/shared/ui/button.tsx';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed bottom-0 left-0 right-0 top-[3.625rem] z-50 bg-background/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    />
  );
});
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    overlayClassName?: string;
    hideClose?: boolean;
    /** `rise` = bottom→center (default). `fade` for full-bleed layers. */
    motion?: 'rise' | 'fade';
  }
>(function DialogContent({ className, children, overlayClassName, hideClose = false, motion = 'rise', ...props }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-[calc(50%+1.75rem)] z-50 flex w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-0 border border-border-2 bg-card text-card-foreground shadow-panel-lg',
          'rounded-lg outline-none',
          motion === 'rise'
            ? 'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out'
            : 'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none',
          className
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close asChild>
            <DialogCloseButton className="absolute right-3 top-3" aria-label="Close" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex shrink-0 items-center gap-2.5 border-b border-border/80 px-4 py-3', className)}
      {...props}
    />
  );
}

/** Icon-only close control for modal chrome (header row or absolute fallback). */
function DialogCloseButton({ className, ...props }: ButtonProps) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={cn('shrink-0 border-transparent text-muted-foreground hover:text-foreground', className)}
      {...props}
    >
      <X className="size-[1.125rem]" strokeWidth={2} aria-hidden />
    </Button>
  );
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3', className)} {...props} />
  );
}

const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title ref={ref} className={cn('type-heading m-0 min-w-0 flex-1 truncate', className)} {...props} />
  );
});
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn('type-body m-0 text-text-3', className)} {...props} />;
});
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogCloseButton,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
};
