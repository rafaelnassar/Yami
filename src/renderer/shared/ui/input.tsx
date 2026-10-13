import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils.ts';

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type = 'text', ...props },
  ref
) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-[42px] min-h-[42px] w-full rounded-md border border-border bg-input/95 px-4 font-sans text-sm text-foreground transition-colors duration-150',
        'placeholder:font-sans placeholder:text-muted-foreground',
        'hover:border-border-2 focus-visible:border-border-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
