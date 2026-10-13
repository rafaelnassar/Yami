import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils.ts';

const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref
) {
  return (
    <textarea
      className={cn(
        'flex min-h-[4.5rem] w-full rounded-md border border-border bg-input/95 px-3.5 py-2.5 font-sans text-sm text-foreground transition-colors duration-150',
        'placeholder:font-sans placeholder:text-muted-foreground',
        'hover:border-border-2 focus-visible:border-border-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
