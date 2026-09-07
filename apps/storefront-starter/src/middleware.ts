import createMiddleware from 'next-intl/middleware';
import { routing } from '@/i18n/routing';

/**
 * Puts every page under a locale prefix and remembers the choice in a cookie.
 *
 * The matcher excludes the route handlers deliberately: `/health` is the container probe and must
 * answer 200 without a redirect, and `/auth/*` carries the OIDC round trip — its callback URL is
 * registered with Keycloak, so it cannot grow a locale prefix.
 */
export default createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|auth|_next|_vercel|health|[^?]*[.][a-zA-Z0-9]+).*)'],
};
