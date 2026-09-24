import { describe, expect, it } from 'vitest';
import { isReferralCode, safeReferralTarget } from '@/lib/referral';
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
