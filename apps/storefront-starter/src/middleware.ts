import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { routing } from '@/i18n/routing';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  mergeAttribution,
  parseAttribution,
  readTouch,
} from '@/lib/attribution';
import { CSP_HEADER, contentSecurityPolicy, newNonce, parseFrameHosts } from '@/lib/csp';
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

/**
 * The campaign embed origins (#782), vetted once per process: a refused entry (wildcard, path,
 * non-https…) is logged once, by value and reason, and never reaches a policy. The list is a
 * build-time constant (next.config.mjs, from window 6's `EMBED_HOSTS`), so the first request is
 * this process's boot as far as the list is concerned.
 */
let frameHosts: string[] | undefined;
function vettedFrameHosts(): string[] {
  if (frameHosts === undefined) {
    const parsed = parseFrameHosts(process.env.CSP_FRAME_HOSTS);
    for (const { entry, reason } of parsed.refused) {
      console.warn(`[csp] CSP_FRAME_HOSTS entry refused (${reason}): ${entry}`);
    }
    frameHosts = parsed.hosts;
  }
  return frameHosts;
}

/** A path with a file extension: a static file, or a missing one Next answers with its 404. */
const FILE_PATH = /\/[^/]*\.[a-zA-Z0-9]+$/;

/**
 * The request the render sees: a named user agent (#274), and this response's policy on
 * `Content-Security-Policy`, which is where Next reads the nonce to stamp its own scripts (#782).
 * (Next also takes it from the response's header; forwarding it as well is what Next documents.)
 */
function forwardedRequest(request: NextRequest, policy: string): NextRequest {
  const headers = new Headers(request.headers);
  if (!headers.get('user-agent')) headers.set('user-agent', UNIDENTIFIED_USER_AGENT);
  headers.set(CSP_HEADER, policy);
  return new NextRequest(request, { headers });
}

export default function middleware(request: NextRequest) {
  // A new nonce per response, built from this deployment's environment (see src/lib/csp.ts for why
  // this cannot live in next.config.mjs). It goes on the response for the browser and on the
  // forwarded request for Next.
  const nonce = newNonce();
  const policy = contentSecurityPolicy({
    nonce,
    keycloakUrl: process.env.KEYCLOAK_URL,
    frameHosts: vettedFrameHosts(),
    pathname: request.nextUrl.pathname,
    production: process.env.NODE_ENV === 'production',
  });
  const forwarded = forwardedRequest(request, policy);

  // A file path gets the policy and nothing else: no locale prefix, no attribution. That includes a
  // missing file, which Next answers with its prerendered `/_not-found` page (#782).
  if (FILE_PATH.test(request.nextUrl.pathname)) {
    const response = NextResponse.next({ request: { headers: forwarded.headers } });
    response.headers.set(CSP_HEADER, policy);
    return response;
  }

  // next-intl forwards the request headers it is given to the render, so what is set above is what
  // the page's renderer reads. Everything below still looks at the request as it arrived. Every
  // response path, redirects included, leaves with the policy.
  const response = intlMiddleware(forwarded);
  response.headers.set(CSP_HEADER, policy);

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

/**
 * Everything except the route handlers (see above) and Next's own build output.
 * - **The exclusions are whole path segments** (#783 review). The old unanchored `api|auth|health`
 *   also skipped `/authors`, `/apiary` and `/healthy`, which then rendered a 404 page with no CSP
 *   at all. `test/middleware-matcher.test.ts` pins both lists.
 * - **File paths are matched since #782**, so that a missing file's 404 page also carries the
 *   policy; the branch above keeps them out of the locale and attribution logic.
 * - **The cost on a `public/` file:** one regex test, a nonce and a policy string per request (the
 *   starter's `public/` holds no files; each brand's holds one SVG placeholder).
 *
 * A literal on purpose: Next reads `config.matcher` statically at build time.
 */
export const config = {
  matcher: ['/((?!api/|api$|auth/|auth$|r/|_next/|_vercel/|_vercel$|health/?$).*)'],
};
