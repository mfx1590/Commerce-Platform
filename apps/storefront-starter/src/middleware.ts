import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { routing } from '@/i18n/routing';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  mergeAttribution,
  parseAttribution,
  readTouch,
} from '@/lib/attribution';

/**
 * Puts every page under a locale prefix, remembers the choice in a cookie, and captures marketing
 * attribution on the way through.
 *
 * The matcher excludes the route handlers deliberately: `/health` is the container probe and must
 * answer 200 without a redirect, and `/auth/*` carries the OIDC round trip — its callback URL is
 * registered with Keycloak, so it cannot grow a locale prefix.
 */
const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const response = intlMiddleware(request);

  // The landing touch has to be recorded before the customer navigates away from the campaign URL,
  // and the middleware is the only thing that sees every request. `document.referrer` is not
  // available on the server; the `Referer` header is the same signal.
  const touch = readTouch(request.nextUrl.searchParams, {
    referrer: request.headers.get('referer'),
    path: request.nextUrl.pathname,
    siteOrigin: request.nextUrl.origin,
  });
  if (touch === null) return response;

  const existing = parseAttribution(request.cookies.get(ATTRIBUTION_COOKIE)?.value);
  const merged = mergeAttribution(existing, touch);
  if (merged === null || merged === existing) return response;

  response.cookies.set(ATTRIBUTION_COOKIE, JSON.stringify(merged), {
    // Readable by the server only: nothing in the browser needs it, and httpOnly keeps it out of
    // reach of any third-party script the brand later adds.
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
  });
  return response;
}

export const config = {
  matcher: ['/((?!api|auth|_next|_vercel|health|[^?]*[.][a-zA-Z0-9]+).*)'],
};
