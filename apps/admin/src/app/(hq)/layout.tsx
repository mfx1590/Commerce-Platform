import type { ReactNode } from 'react';
import { Shell } from '@/components/shell/shell';

export const dynamic = 'force-dynamic';

/**
 * HQ view. `requireHq` only asserts the principal has *some* HQ section — the page's own
 * `HqSectionGuard` decides whether they may have this one.
 */
export default function HqLayout({ children }: { children: ReactNode }) {
  return <Shell requireHq>{children}</Shell>;
}
