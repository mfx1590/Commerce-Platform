/**
 * The CSP zones (#782, the manager's decision in the #783 review).
 *
 * The **checkout zone** is the pages that mount Stripe's Payment Element (the checkout steps) and
 * the order confirmation, which placing an order reaches in the same document. Their `frame-src` is
 * Stripe's hosts only. **Everywhere else** frames Stripe and the vetted campaign embed hosts.
 *
 * A Content-Security-Policy binds to the document it arrived with, so crossing between the zones
 * must load a new document, in both directions. `ZoneBoundary` (in the root layout) enforces that.
 * A plain module, no React: the middleware's policy and the browser's boundary use the same rule.
 */
export function isCheckoutZone(pathname: string): boolean {
  return /^\/[^/.]+\/(checkout|orders)(\/|$)/.test(pathname);
}
