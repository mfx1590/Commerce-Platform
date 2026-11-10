import { notFound } from 'next/navigation';

/**
 * Any path under a locale that no route matches (#782).
 *
 * Without this, Next answers an unknown `/<locale>/…` with its prerendered default `/_not-found`:
 * static HTML outside the locale layout, so it carried no CSP nonce, its scripts were blocked by
 * the nonce policy, and it was not the store's page anyway. Calling `notFound()` here renders
 * `[locale]/not-found.tsx` inside the (dynamic) locale layout: the store's own 404, localised,
 * with this response's nonce. A static route or a more specific dynamic one always wins over a
 * catch-all, so no real page can land here.
 */
export default function UnknownPath() {
  notFound();
}
