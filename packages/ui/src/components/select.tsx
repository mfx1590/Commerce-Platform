import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

/**
 * A styled native `<select>`. Native on purpose: it is keyboard- and screen-reader-correct
 * everywhere, works without JavaScript inside a plain form post, and needs no popover library.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid === true ? true : undefined}
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        invalid === true && 'border-destructive focus-visible:ring-destructive',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});
