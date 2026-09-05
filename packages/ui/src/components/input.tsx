import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the field invalid and wires `aria-invalid` (the message is rendered by the form). */
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type ?? 'text'}
      aria-invalid={invalid === true ? true : undefined}
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        invalid === true && 'border-destructive focus-visible:ring-destructive',
        className,
      )}
      {...props}
    />
  );
});
