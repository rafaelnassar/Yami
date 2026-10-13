import * as ProgressPrimitive from '@radix-ui/react-progress';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/shared/lib/utils.ts';

const Progress = forwardRef<
  ElementRef<typeof ProgressPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
    indeterminate?: boolean;
    tone?: 'ok' | 'neutral';
  }
>(function Progress({ className, value, indeterminate = false, tone = 'ok', ...props }, ref) {
  const fill = tone === 'ok' ? 'bg-ok' : 'bg-text-3';
  return (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full border border-border bg-input', className)}
      value={indeterminate ? undefined : value}
      {...props}
    >
      {indeterminate ? (
        <span className={cn('runtime-progress-indeterminate absolute inset-y-0 left-0 w-1/3 rounded-full', fill)} />
      ) : (
        <ProgressPrimitive.Indicator
          className={cn(
            'h-full w-full flex-1 rounded-full transition-[transform] duration-200 motion-reduce:transition-none',
            fill
          )}
          style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
        />
      )}
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
