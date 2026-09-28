import { describe, expect, it } from 'vitest';
import { isReferralCode, safeReferralTarget } from '@/lib/referral';
import { isSameOrigin, isSafeInternalPath } from '@/lib/safe-path';
import { mergeAttribution, parseAttribution, readTouch } from '@/lib/attribution';

/**
 * `/r/{code}` (task 2.4). A referral link is shared publicly and clicked without inspection, so
 * both of its inputs — the code and the `to` target — are untrusted.
 */

describe('isReferralCode', () => {
  it('accepts the opaque tokens window 17 generates', () => {
    for (const code of ['jane', 'JANE-2026', 'ref_alpha_beta', 'a'.repeat(64)]) {
      expect(isReferralCode(code)).toBe(true);
    }
  });

  it('refuses anything that could confuse a cookie, a path or a log line', () => {
    for (const code of [
      '',
      'abc', // too short to be a real code
      'a'.repeat(65),
      'has space',
      'has/slash',
      'has.dot', // a dot would read as a file extension to the middleware matcher
      'has\\backslash',
      '../../etc/passwd',
      '<script>',
      'sémi-colon;',
      undefined,
      null,
    ]) {
      expect(isReferralCode(code)).toBe(false);
    }
  });
});

describe('safeReferralTarget', () => {
  it('keeps a same-site path', () => {
    expect(safeReferralTarget('/en-GB/products')).toBe('/en-GB/products');
    expect(safeReferralTarget('/en-GB/products?sort=price_asc')).toBe(
      '/en-GB/products?sort=price_asc',
    );
  });

  it('refuses another origin — a referral link must not launder a link to someone else', () => {
    for (const target of [
      'https://evil.example',
      'http://evil.example/x',
      '//evil.example', // protocol-relative: the browser reads this as another origin
      '/\\evil.example',
      '/path\\with\\backslashes',
      'javascript:alert(1)',
      '',
      undefined,
      null,
    ]) {
      expect(safeReferralTarget(target)).toBe('/');
    }
  });

  it('refuses another referral, which would re-enter the handler on every hop', () => {
    expect(safeReferralTarget('/r/other-code')).toBe('/');
    expect(safeReferralTarget('/r')).toBe('/');
  });

  it('takes the caller’s fallback when there is nothing usable', () => {
    expect(safeReferralTarget('https://evil.example', '/en-GB')).toBe('/en-GB');
  });
});

/**
 * The open redirect found in review of #273, and the reason there are now two layers.
 *
 * WHATWG URL parsing strips tab, newline and carriage return **before** parsing, so a target that
 * starts with a single `/` can still resolve to another origin. `searchParams.get()` decodes `%09`,
 * `%0A` and `%0D` into exactly those characters, so `?to=%2F%09%2Fevil.example` was enough to make a
 * publicly shared referral link redirect to somebody else's site.
 */
describe('control characters cannot smuggle another origin past the guard', () => {
  const origin = 'https://shop.example';

  /** The three URL parsing actually strips — these are the exploit. */
  const stripped = [
    ['%09 tab', '/\t/evil.example'],
    ['%0A newline', '/\n/evil.example'],
    ['%0D carriage return', '/\r/evil.example'],
  ] as const;

  /** Rejected as well, on principle: a parser folding any of these later is not a rule we control. */
  const alsoRejected = [
    ['NUL', '/\u0000/evil.example'],
    ['DEL', '/\u007f/evil.example'],
    ['U+2028 line separator', '/\u2028/evil.example'],
  ] as const;

  it('the stripped three really do resolve off-origin — this is the defect', () => {
    // Stated so nobody "simplifies" the guard back out again.
    for (const [label, raw] of stripped) {
      expect(new URL(raw, origin).origin, label).toBe('https://evil.example');
    }
  });

  it('the others do not resolve off-origin today; they are refused anyway', () => {
    // Honest about the difference: these are defence in depth, not a demonstrated bypass.
    for (const [label, raw] of alsoRejected) {
      expect(new URL(raw, origin).origin, label).toBe(origin);
    }
  });

  it('safeReferralTarget rejects every one of them', () => {
    for (const [label, raw] of [...stripped, ...alsoRejected]) {
      expect(safeReferralTarget(raw), label).toBe('/');
      expect(isSafeInternalPath(raw), label).toBe(false);
    }
  });

  it('and what it returns instead resolves to this origin', () => {
    for (const [label, raw] of [...stripped, ...alsoRejected]) {
      const destination = new URL(safeReferralTarget(raw), origin);
      expect(destination.origin, label).toBe(origin);
      expect(isSameOrigin(destination, origin), label).toBe(true);
    }
  });

  it('a decoded query parameter is what the route actually sees', () => {
    // How the payload arrives: the encoded form in the link, decoded by searchParams.
    const url = new URL('https://shop.example/r/jane?to=%2F%09%2Fevil.example');
    const to = url.searchParams.get('to');
    expect(to).toBe('/\t/evil.example');
    expect(safeReferralTarget(to)).toBe('/');
  });
});

/**
 * The cookie behaviour the acceptance criterion asks for. The route handler reuses `readTouch` and
 * `mergeAttribution`, so this asserts the composition rather than a second implementation of it.
 */
describe('the referral touch', () => {
  const site = 'https://brand-a.example';
  const touchFor = (code: string, at: Date) =>
    readTouch(new URLSearchParams({ ref: code }), {
      referrer: null,
      path: `/r/${code}`,
      siteOrigin: site,
      now: at,
    });

  it('records the code as `ref`, with the clicked path as the landing', () => {
    const attribution = mergeAttribution(null, touchFor('jane', new Date('2026-09-24T10:00:00Z')));

    expect(attribution?.first.ref).toBe('jane');
    expect(attribution?.first.landing_path).toBe('/r/jane');
    // It rides to the order as cart.metadata.attribution.*.ref — no contract change needed.
    expect(attribution?.last.ref).toBe('jane');
  });

  it('preserves the first touch and updates the last on a second referral', () => {
    const first = mergeAttribution(null, touchFor('jane', new Date('2026-09-24T10:00:00Z')));
    const second = mergeAttribution(first, touchFor('sam', new Date('2026-09-25T10:00:00Z')));

    // Whoever actually acquired the customer keeps the credit.
    expect(second?.first.ref).toBe('jane');
    expect(second?.last.ref).toBe('sam');
    expect(second?.captured_at).toBe('2026-09-25T10:00:00.000Z');
  });

  it('does not overwrite an earlier campaign touch with the referral', () => {
    const campaign = mergeAttribution(
      null,
      readTouch(new URLSearchParams('utm_source=newsletter&utm_campaign=spring'), {
        referrer: null,
        path: '/en-GB',
        siteOrigin: site,
        now: new Date('2026-09-20T10:00:00Z'),
      }),
    );
    const merged = mergeAttribution(campaign, touchFor('jane', new Date('2026-09-24T10:00:00Z')));

    expect(merged?.first.utm_source).toBe('newsletter');
    expect(merged?.last.ref).toBe('jane');
  });

  it('round-trips through the cookie, so the handler can write what the cart later reads', () => {
    const attribution = mergeAttribution(null, touchFor('jane', new Date('2026-09-24T10:00:00Z')));
    expect(parseAttribution(JSON.stringify(attribution))?.last.ref).toBe('jane');
  });
});
