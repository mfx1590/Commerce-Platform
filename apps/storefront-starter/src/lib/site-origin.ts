import { siteUrl } from '@/brand/config';
import { isSafeInternalPath, isSameOrigin } from './safe-path';

/**
 * Where a route handler may send a customer: **this site, as configured — never as requested**
 * (#298).
 *
 * Every redirect issued by a route handler used to be built on `request.nextUrl.origin`. Behind
 * the ingress that is the pod's own address: measured on `next start`, it is `localhost:3100`
 * whatever `Host` or `X-Forwarded-Host` says (only the scheme follows `X-Forwarded-Proto`). So in
 * any deployment, sign-out handed Keycloak `http://localhost:3100/` as the place to return to, the
 * sign-in callback sent a freshly authenticated customer to `https://localhost:3100/…`, and every
 * referral link landed on localhost. No test saw it, because on a laptop the public origin *is*
 * `localhost:3100`.
 *
 * Taking the origin from the request headers instead would be worse, not better: a `Host` header is
 * attacker-supplied text, and a redirect built on it is an open redirect. The origin is therefore
 * configuration (`siteUrl()`: `SITE_URL`, or the brand's fixed origin), read at request time, and
 * `siteUrl()` fails closed when a production server has none.
 *
 * `request.nextUrl` is still the right source for the *path and query* of the request; it is only
 * its origin that describes the pod rather than the site.
 */

/** This site's origin, e.g. `https://shop.example.com`. Throws `SiteUrlError` when unconfigured. */
export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  return new URL(siteUrl(env)).origin;
}

/**
 * The absolute URL on this site for `path` — or for `fallbackPath` when `path` is not one of ours.
 *
 * Both layers of the safe-path rule, in the one place every redirect goes through: the string rule
 * (`isSafeInternalPath`), then the origin the URL parser actually resolved (`isSameOrigin`),
 * because a path can pass the first and still leave the site. `fallbackPath` is always a literal
 * of ours.
 */
export function urlOnThisSite(
  path: string | null | undefined,
  fallbackPath: string,
  env: Record<string, string | undefined> = process.env,
): URL {
  const origin = siteOrigin(env);
  if (isSafeInternalPath(path)) {
    const destination = new URL(path, origin);
    if (isSameOrigin(destination, origin)) return destination;
  }
  return new URL(fallbackPath, origin);
}
