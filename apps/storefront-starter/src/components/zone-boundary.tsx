'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { isCheckoutZone } from '@/lib/csp-zone';

/**
 * Makes every crossing of the CSP zone boundary a hard navigation, in both directions (#782).
 *
 * The checkout zone's document must carry the checkout zone's policy, and every other page's
 * document the other zone's. A client-side navigation keeps the document, and with it the policy,
 * of the page it started from. Two layers:
 *
 * 1. **Clicks.** A capture-phase listener on the document sees a link click before Next's `<Link>`
 *    does. If the link is same-origin and its target is in the other zone, the click becomes
 *    `location.assign()`: a new document, carrying its own policy. That covers every link, the
 *    brand's logo and chrome included, without a component knowing about zones.
 * 2. **Anything else** (a server-action redirect, `router.push`): if the pathname reaches the other
 *    zone without a new document, the page reloads at that URL.
 *
 * Renders nothing.
 */
export function ZoneBoundary() {
  const pathname = usePathname();
  // The zone of the document as it was loaded: a soft navigation never changes it.
  const documentZone = useRef<boolean | null>(null);

  useEffect(() => {
    documentZone.current ??= isCheckoutZone(window.location.pathname);

    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target !== '' && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (isCheckoutZone(url.pathname) === isCheckoutZone(window.location.pathname)) return;
      // Stop Next's <Link> from turning it into a soft navigation.
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(url.href);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    if (documentZone.current === null) return;
    if (isCheckoutZone(window.location.pathname) !== documentZone.current) {
      window.location.reload();
    }
  }, [pathname]);

  return null;
}
