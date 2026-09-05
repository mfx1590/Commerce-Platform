import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

/** Loading placeholder. Hidden from assistive tech; announce loading state on the region instead. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      data-testid="skeleton"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}
