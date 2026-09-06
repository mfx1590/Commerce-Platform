import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';
import { variants, type VariantProps } from '../lib/variants.js';

const badgeVariants = variants({
  base: 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
  variants: {
    variant: {
      neutral: 'bg-muted text-muted-foreground',
      primary: 'bg-primary text-primary-foreground',
      success: 'bg-success text-success-foreground',
      destructive: 'bg-destructive text-destructive-foreground',
      outline: 'border border-border text-foreground',
    },
  },
  defaults: { variant: 'neutral' },
});

export type BadgeVariants = VariantProps<{
  variant: Record<'neutral' | 'primary' | 'success' | 'destructive' | 'outline', string>;
}>;

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & BadgeVariants;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
