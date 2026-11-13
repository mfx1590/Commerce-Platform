'use client';

import { useEffect } from 'react';

/**
 * Sets `<html data-hydrated="true">` once React has hydrated the page (#327).
 *
 * The end-to-end suite used to wait for network quiet before clicking, as a stand-in for "the page
 * can act on a click now". Network quiet waits on everything — images from a remote host included —
 * and nothing in particular. This says the one thing a click needs: the handlers are attached. The
 * app has no Suspense boundary or `loading.tsx`, so the root commit hydrates the whole page and this
 * effect runs after it. A client-side navigation keeps the attribute, correctly: React renders the
 * new page itself, handlers included. Discloses nothing (see `src/lib/test-hooks.ts` on markup that
 * ships to production).
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
