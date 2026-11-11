/**
 * The storefront's route handlers outside the locale tree, and what the middleware does with them
 * (#790). Plain and pure, so a unit test can check this list against the `route.ts` files on disk.
 *
 * The middleware matches every path except Next's own build output, so every response carries the
 * Content-Security-Policy (#782). Paths under the route-handler prefixes are kept out of the locale
 * logic, because none of them may grow a locale prefix:
 * - `/health` is the container probe and must answer 200 without a redirect;
 * - `/auth/*` carries the OIDC round trip, whose callback URL is registered with Keycloak;
 * - `/r/<code>` is the referral landing, a shared short link that must not take a second hop;
 * - `/api/*` are the CMS webhooks.
 *
 * - **A real handler** passes straight through to it, with the policy header.
 * - **Anything else under those prefixes** (`/api`, `/api/nope`, `/auth/x`, `/r/a/b`) has no handler
 *   and no page. It is answered by the middleware with a plain-text 404, not an HTML page that
 *   would need a nonce, and still carries the policy. It used to skip the middleware and render
 *   the locale 404 with no policy at all (#790).
 */

/** Every handler outside `[locale]`. `test/route-handlers.test.ts` keeps it equal to the disk. */
export const ROUTE_HANDLERS: readonly RegExp[] = [
  /^\/api\/cms\/preview$/,
  /^\/api\/cms\/preview\/exit$/,
  /^\/api\/cms\/revalidate$/,
  /^\/auth\/callback$/,
  /^\/auth\/sign-in$/,
  /^\/auth\/sign-out$/,
  /^\/health$/,
  /^\/r\/[^/]+$/,
];

/** The prefixes that belong to route handlers, never to a page. */
const HANDLER_PREFIX = /^\/(api|auth|health|r)(\/|$)/;

export type HandlerPath = 'handler' | 'no-handler' | 'page';

/**
 * - `handler`: a real route handler; pass through.
 * - `no-handler`: under a handler prefix with no handler; answer a plain-text 404.
 * - `page`: anything else; the locale tree.
 */
export function classifyPath(pathname: string): HandlerPath {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (ROUTE_HANDLERS.some((handler) => handler.test(path))) return 'handler';
  return HANDLER_PREFIX.test(path) ? 'no-handler' : 'page';
}
