import { Loader2 } from 'lucide-react';
import { cn } from '@/shared/lib/utils.ts';

/** Lucide spinner used for in-button / inline loading states. */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn('size-[1.125rem] animate-spin motion-reduce:animate-none', className)}
      strokeWidth={2}
      aria-hidden
    />
  );
}
