import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';
import { variants, type VariantProps } from '../lib/variants.js';

const buttonVariants = variants({
  base: 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  variants: {
    variant: {
      primary: 'bg-primary text-primary-foreground hover:opacity-90',
      secondary: 'bg-secondary text-secondary-foreground hover:opacity-90',
      outline: 'border border-border bg-background text-foreground hover:bg-muted',
      ghost: 'bg-transparent text-foreground hover:bg-muted',
      destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
      link: 'bg-transparent text-primary underline-offset-4 hover:underline',
    },
    size: {
      sm: 'h-8 px-3 text-sm',
      md: 'h-10 px-4 text-base',
      lg: 'h-12 px-6 text-lg',
      icon: 'h-10 w-10 p-0',
    },
  },
  defaults: { variant: 'primary', size: 'md' },
});

export type ButtonVariants = VariantProps<{
  variant: Record<'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link', string>;
  size: Record<'sm' | 'md' | 'lg' | 'icon', string>;
}>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonVariants {
  /** Renders a spinner-free busy state: disabled plus `aria-busy` for screen readers. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, disabled, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled === true || loading === true}
      aria-busy={loading === true ? true : undefined}
      {...props}
    />
  );
});

export { buttonVariants };
