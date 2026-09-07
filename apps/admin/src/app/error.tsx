'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { StatePanel } from '@/components/states/state-panel';

/**
 * The App Router error boundary: whatever a route threw that the API layer did not already turn
 * into a panel — a rendering bug, a failed `redirect`, a library throwing.
 *
 * `digest` is the only detail shown. The message of a server-side error may contain anything the
 * server was holding, and this app handles tokens and customer data; the digest is the safe handle
 * for correlating with the server log.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Not `console.log`: this is a real fault and belongs in whatever collects errors. No PII —
    // the digest correlates with the full server-side entry.
    console.error('admin: unhandled route error', error.digest ?? error.message);
  }, [error]);

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <StatePanel
        title="Something went wrong on this page"
        description="The rest of the app is unaffected."
        action={<Button onClick={reset}>Try again</Button>}
      >
        {error.digest !== undefined && (
          <p className="text-muted text-sm">
            Reference <span className="font-mono text-xs">{error.digest}</span> — quote it if you
            report this.
          </p>
        )}
      </StatePanel>
    </main>
  );
}
