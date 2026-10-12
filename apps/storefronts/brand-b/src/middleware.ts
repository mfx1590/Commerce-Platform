import createMiddleware from 'next-intl/middleware';
import { NextRequest } from 'next/server';
import { routing } from '@/i18n/routing';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  mergeAttribution,
  parseAttribution,
  readTouch,
} from '@/lib/attribution';
import { contentSecurityPolicy } from '@/lib/csp';
import { siteOrigin } from '@/lib/site-origin';

/**
 * Puts every page under a locale prefix, remembers the choice in a cookie, and captures marketing
 * attribution on the way through.
 *
 * The matcher excludes the route handlers deliberately: `/health` is the container probe and must
 * answer 200 without a redirect, `/auth/*` carries the OIDC round trip — its callback URL is
 * registered with Keycloak, so it cannot grow a locale prefix — and `/r/*` is the referral landing,
 * a shared short link that must not have to carry a locale and must not take a second redirect hop.
 */
const intlMiddleware = createMiddleware(routing);

/**
 * What a request with no `User-Agent` header is rendered as (#274).
 *
 * `htmlLimitedBots` in next.config.mjs holds the metadata in `<head>` for every agent that names
 * itself, but Next never consults the pattern for one that does not: with no header the metadata is
 * streamed, and lands after `</head>` on all but the luckiest request. A bare HTTP client is a
 * crawler far more often than a customer, so it is given a name here and the page it receives is
 * the same one everybody else gets. The value is only ever seen by the render.
 */
const UNIDENTIFIED_USER_AGENT = 'unidentified';

function withUserAgent(request: NextRequest): NextRequest {
  if (request.headers.get('user-agent')) return request;
  const headers = new Headers(request.headers);
  headers.set('user-agent', UNIDENTIFIED_USER_AGENT);
  return new NextRequest(request, { headers });
}

export default function middleware(request: NextRequest) {
  // next-intl forwards the request headers it is given to the render, so the default set here is
  // what the page's renderer reads. Everything below still looks at the request as it arrived.
  const response = intlMiddleware(withUserAgent(request));

  // Built per request from this deployment's environment — see src/lib/csp.ts for why this cannot
  // live in next.config.mjs. Every page response passes through here; the routes the matcher skips
  // (`/api`, `/auth`, `/health`, static files) render no document to protect.
  response.headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy({
      keycloakUrl: process.env.KEYCLOAK_URL,
      frameHosts: process.env.CSP_FRAME_HOSTS,
    }),
  );

  // The landing touch has to be recorded before the customer navigates away from the campaign URL,
  // and the middleware is the only thing that sees every request. `document.referrer` is not
  // available on the server; the `Referer` header is the same signal.
  const touch = readTouch(request.nextUrl.searchParams, {
    referrer: request.headers.get('referer'),
    path: request.nextUrl.pathname,
    // The **configured** origin (#298). The request's own is the pod's behind the ingress
    // (`localhost:3100`), so a `Referer` on the public origin — every click from one of our own
    // pages to another — looked like somebody else's site: measured, each in-shop navigation wrote
    // an attribution cookie naming the shop itself as the referrer, overwriting the last touch.
    siteOrigin: siteOrigin(),
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
  matcher: ['/((?!api|auth|r/|_next|_vercel|health|[^?]*[.][a-zA-Z0-9]+).*)'],
};
