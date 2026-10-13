import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/shared/lib/utils.ts';

/**
 * Control scale (present, comfortable dense):
 * - sm / icon-sm → 36px
 * - default / icon → 42 / 40px
 * - lg → 46px
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2.5 whitespace-nowrap rounded-md border font-medium font-sans leading-none transition-colors duration-150 ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
    'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40 ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:self-center',
  {
    variants: {
      variant: {
        default:
          'border-border-3 bg-primary text-primary-foreground shadow-none hover:bg-primary/90 active:bg-primary/80',
        destructive:
          'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:border-destructive/55 active:bg-destructive/20',
        outline: 'border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground',
        secondary:
          'border-border bg-input text-text-2 hover:bg-surface-2 hover:border-border-2 hover:text-text active:bg-surface-hover',
        ghost:
          'border-transparent bg-transparent text-text-2 hover:bg-surface-2 hover:text-text active:bg-surface-2/90',
        link: 'border-transparent bg-transparent text-primary underline-offset-4 hover:underline',
        /** Legacy aliases kept for call-site compatibility. */
        primary:
          'border-border-3 bg-text text-bg shadow-none hover:bg-text-2 active:bg-text-3 disabled:border-border disabled:bg-surface-2 disabled:text-text-4',
        danger: 'border-border-2 bg-surface-2 text-err hover:bg-err/12 hover:border-err active:bg-err/18'
      },
      size: {
        default: 'h-[42px] min-h-[42px] px-4 text-sm [&_svg]:size-[1.125rem]',
        sm: 'h-9 min-h-9 px-3.5 text-sm gap-2 [&_svg]:size-[1.125rem]',
        lg: 'h-[46px] min-h-[46px] px-5 text-sm gap-2.5 [&_svg]:size-5',
        icon: 'h-10 w-10 min-h-10 min-w-10 p-0 [&_svg]:size-[1.125rem]',
        'icon-sm': 'h-9 w-9 min-h-9 min-w-9 p-0 [&_svg]:size-[1.125rem]',
        /** Legacy alias */
        md: 'h-[42px] min-h-[42px] px-4 text-sm [&_svg]:size-[1.125rem]'
      }
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default'
    }
  }
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** @deprecated Prefer `size="icon"` or `size="icon-sm"`. */
  iconOnly?: boolean;
  fullWidth?: boolean;
}

function resolveIconOnlySize(size: ButtonProps['size'], iconOnly: boolean | undefined): ButtonProps['size'] {
  if (!iconOnly) return size;
  if (size === 'icon' || size === 'icon-sm') return size;
  if (size === 'sm') return 'icon-sm';
  if (size === 'lg') return 'icon';
  if (size === 'md' || size === 'default' || size === undefined) return 'icon';
  return size;
}

const iconOnlyMinWidth: Partial<Record<NonNullable<ButtonProps['size']>, string>> = {
  'icon-sm': 'min-w-9',
  icon: 'min-w-10',
  default: 'min-w-[42px]',
  md: 'min-w-[42px]',
  sm: 'min-w-9',
  lg: 'min-w-[46px]'
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, iconOnly, fullWidth, type = 'button', ...props },
  ref
) {
  const Comp = asChild ? Slot : 'button';
  const resolvedSize = resolveIconOnlySize(size, iconOnly);
  return (
    <Comp
      type={asChild ? undefined : type}
      className={cn(
        buttonVariants({ variant, size: resolvedSize }),
        iconOnly && resolvedSize ? iconOnlyMinWidth[resolvedSize] : null,
        fullWidth && 'w-full',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };
