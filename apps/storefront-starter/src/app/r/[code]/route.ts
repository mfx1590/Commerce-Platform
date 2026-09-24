import { NextResponse, type NextRequest } from 'next/server';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  mergeAttribution,
  parseAttribution,
  readTouch,
} from '@/lib/attribution';
import { isReferralCode, safeReferralTarget } from '@/lib/referral';

/**
 * `/r/{code}` — the referral landing (task 2.4, docs/marketing-scope.md).
 *
 * A short link somebody shares. It records the referral code as a marketing touch and sends the
 * visitor on, so the code reaches the order through `cart.metadata.attribution.*.ref` exactly like a
 * `?ref=` parameter — no contract change, and window 17's reporting needs nothing new.
 *
 * It lives **outside `[locale]`**, and the middleware matcher skips it, for two reasons: a printed
 * or texted referral link should not have to carry a locale, and the redirect here would otherwise
 * be a second hop after next-intl's own. The visitor's locale is decided by the page they land on,
 * which redirects to their locale as usual.
 *
 * 302, not 308: this is a marketing hop, and a browser (or a scanner) must not cache it as a
 * permanent move — the destination is a query parameter and the cookie write has to happen on every
 * click, not once.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  const target = safeReferralTarget(request.nextUrl.searchParams.get('to'));
  const destination = new URL(target, request.nextUrl.origin);

  // An unrecognisable code still sends the visitor to the shop: a mistyped or truncated link is a
  // customer we would rather have than a 404. It simply records nothing.
  if (!isReferralCode(code)) {
    return NextResponse.redirect(destination, 302);
  }

  // The same touch shape the middleware writes for `?ref=`, so first/last-touch merging, the size
  // cap and the no-PII rule all apply unchanged — `readTouch` is the single definition of a touch.
  const search = new URLSearchParams(request.nextUrl.searchParams);
  search.set('ref', code);
  const touch = readTouch(search, {
    referrer: request.headers.get('referer'),
    // What the visitor actually clicked, which is what a report should show as the landing.
    path: request.nextUrl.pathname,
    siteOrigin: request.nextUrl.origin,
  });

  const response = NextResponse.redirect(destination, 302);
  if (touch === null) return response;

  const merged = mergeAttribution(
    parseAttribution(request.cookies.get(ATTRIBUTION_COOKIE)?.value),
    touch,
  );
  if (merged === null) return response;

  response.cookies.set(ATTRIBUTION_COOKIE, JSON.stringify(merged), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
  });
  return response;
}
