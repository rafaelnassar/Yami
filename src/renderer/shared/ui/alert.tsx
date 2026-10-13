import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils.ts';

const alertVariants = cva(
  'relative w-full rounded-md border px-3 py-2.5 text-sm [&>svg+div]:translate-y-[-1px] [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-3 [&>svg]:size-[1.125rem] [&>svg]:text-foreground [&>svg~*]:pl-8',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-foreground',
        destructive: 'border-destructive/30 bg-destructive/[0.07] text-destructive [&>svg]:text-destructive'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
);

const Alert = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>>(
  function Alert({ className, variant, ...props }, ref) {
    return <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
  }
);
Alert.displayName = 'Alert';

const AlertTitle = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLHeadingElement>>(function AlertTitle(
  { className, ...props },
  ref
) {
  return <h5 ref={ref} className={cn('mb-0.5 font-medium leading-none tracking-tight', className)} {...props} />;
});
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function AlertDescription({ className, ...props }, ref) {
    return (
      <div ref={ref} className={cn('text-xs text-muted-foreground [&_p]:leading-relaxed', className)} {...props} />
    );
  }
);
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
