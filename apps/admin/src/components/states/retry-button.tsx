'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';

/**
 * `router.refresh()` re-runs the server components for the current route, so a retry re-issues the
 * failed request without a full page load and without losing the URL's table state.
 *
 * The only panel that offers this is the network/5xx one: retrying a 403 would fail identically and
 * a retry button that cannot work is worse than none.
 */
export function RetryButton({ label = 'Try again' }: { label?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button disabled={isPending} onClick={() => startTransition(() => router.refresh())}>
      {isPending ? 'Retrying…' : label}
    </Button>
  );
}
