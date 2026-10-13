import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils.ts';

const badgeVariants = cva(
  'inline-flex h-7 min-h-7 shrink-0 items-center justify-center self-center border font-sans text-xs font-semibold normal-case leading-none tabular-nums tracking-normal',
  {
    variants: {
      variant: {
        default: 'border-border-2/90 bg-muted/95 text-secondary-foreground',
        secondary: 'border-border/70 bg-input/85 text-text-3',
        outline: 'border-border-2 bg-muted text-text-3',
        destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
        /** Legacy aliases kept for call-site compatibility. */
        neutral: 'border-border-2/90 bg-muted/95 text-secondary-foreground',
        subtle: 'border-border/70 bg-input/85 text-text-3',
        accent: 'border-border-2 bg-muted text-text-3',
        overlay: 'border-border/80 bg-background/88 text-secondary-foreground backdrop-blur-sm',
        warn: 'border-warn/40 bg-warn/10 text-warn'
      },
      shape: {
        /** Status / category tag */
        default: 'min-w-7 rounded-md px-2.5',
        /** Count / filter chip */
        pill: 'min-w-7 rounded-full px-2.5'
      }
    },
    defaultVariants: {
      variant: 'default',
      shape: 'default'
    }
  }
);

export interface BadgeProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, shape, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, shape }), className)} {...props}>
      <span className="block max-w-full truncate px-px">{children}</span>
    </div>
  );
}

export { Badge, badgeVariants };
