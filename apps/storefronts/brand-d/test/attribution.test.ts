import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_COOKIE_MAX_BYTES,
  attributionCookieBytes,
  mergeAttribution,
  metadataFor,
  parseAttribution,
  readTouch,
  referrerOrigin,
  type Attribution,
} from '@/lib/attribution';

const SITE = 'https://brand-a.example.com';
const AT = new Date('2026-09-07T10:00:00.000Z');
const LATER = new Date('2026-09-14T09:30:00.000Z');

function touchFrom(query: string, options: { referrer?: string; path?: string; now?: Date } = {}) {
  return readTouch(new URLSearchParams(query), {
    referrer: options.referrer ?? null,
    path: options.path ?? '/en-GB/products',
    siteOrigin: SITE,
    now: options.now ?? AT,
  });
}

describe('readTouch', () => {
  it('captures every UTM parameter, the referral code and the landing path', () => {
    const touch = touchFrom(
      'utm_source=newsletter&utm_medium=email&utm_campaign=spring&utm_term=tee&utm_content=hero&ref=jane',
      { referrer: 'https://news.example.com/issue-4?email=someone%40example.com' },
    );

    expect(touch).toEqual({
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'spring',
      utm_term: 'tee',
      utm_content: 'hero',
      ref: 'jane',
      // Origin only: the referring URL's query string carried an email address.
      referrer: 'https://news.example.com',
      landing_path: '/en-GB/products',
      at: '2026-09-07T10:00:00.000Z',
    });
  });

  it('is null for an ordinary visit, so no cookie is written', () => {
    expect(touchFrom('')).toBeNull();
    expect(touchFrom('page=2&sort=price_asc')).toBeNull();
    // Internal navigation is not a marketing touch.
    expect(touchFrom('', { referrer: `${SITE}/en-GB` })).toBeNull();
  });

  it('counts an external referrer alone as a touch', () => {
    expect(touchFrom('', { referrer: 'https://blog.example.com/post' })?.referrer).toBe(
      'https://blog.example.com',
    );
  });

  it('ignores blank and whitespace-only parameters', () => {
    expect(touchFrom('utm_source=&utm_medium=%20%20')).toBeNull();
  });

  it('truncates an over-long value rather than letting it bloat the cookie', () => {
    const touch = touchFrom(`utm_campaign=${'x'.repeat(500)}`);
    expect(touch?.utm_campaign).toHaveLength(200);
  });
});

describe('referrerOrigin', () => {
  it('keeps only the origin and drops same-site and unparseable referrers', () => {
    expect(referrerOrigin('https://x.example.com/a/b?c=d#e', SITE)).toBe('https://x.example.com');
    expect(referrerOrigin(`${SITE}/en-GB/products`, SITE)).toBeNull();
    expect(referrerOrigin('not a url', SITE)).toBeNull();
    expect(referrerOrigin(null, SITE)).toBeNull();
  });
});

describe('mergeAttribution', () => {
  const first = touchFrom('utm_source=newsletter&utm_campaign=spring')!;
  const second = touchFrom('utm_source=google&utm_campaign=brand', { now: LATER })!;

  it('records both touches as the same value on a first visit', () => {
    const merged = mergeAttribution(null, first);
    expect(merged).toEqual({ first, last: first, captured_at: first.at });
  });

  it('never overwrites the first touch', () => {
    // The first campaign acquired the customer; crediting the last one for that work is the bug
    // this whole feature exists to avoid.
    const merged = mergeAttribution(mergeAttribution(null, first), second);
    expect(merged?.first).toEqual(first);
    expect(merged?.first.utm_source).toBe('newsletter');
  });

  it('replaces the last touch and moves captured_at', () => {
    const merged = mergeAttribution(mergeAttribution(null, first), second);
    expect(merged?.last).toEqual(second);
    expect(merged?.captured_at).toBe('2026-09-14T09:30:00.000Z');
  });

  it('leaves what is stored untouched when the visit carries no signal', () => {
    const existing = mergeAttribution(null, first);
    expect(mergeAttribution(existing, null)).toBe(existing);
    expect(mergeAttribution(null, null)).toBeNull();
  });
});

describe('parseAttribution', () => {
  it('reads back what was written', () => {
    const stored = mergeAttribution(null, touchFrom('utm_source=newsletter')!);
    expect(parseAttribution(JSON.stringify(stored))).toEqual(stored);
  });

  it('treats a corrupted or truncated cookie as no attribution', () => {
    expect(parseAttribution(undefined)).toBeNull();
    expect(parseAttribution('')).toBeNull();
    expect(parseAttribution('{"first":{')).toBeNull();
    expect(parseAttribution('"a string"')).toBeNull();
    expect(parseAttribution('{"first":{},"last":{}}')).toBeNull();
  });
});

describe('the JSON sent to the Store API', () => {
  it('is exactly cart.metadata.attribution = { first, last, captured_at }', () => {
    const attribution = mergeAttribution(
      mergeAttribution(null, touchFrom('utm_source=newsletter&utm_medium=email')!),
      touchFrom('utm_source=google&utm_medium=cpc', { path: '/en-GB', now: LATER })!,
    ) as Attribution;

    // The exact body `POST /store/carts` receives.
    expect(JSON.parse(JSON.stringify(metadataFor(attribution)))).toEqual({
      attribution: {
        first: {
          utm_source: 'newsletter',
          utm_medium: 'email',
          utm_campaign: null,
          utm_term: null,
          utm_content: null,
          ref: null,
          referrer: null,
          landing_path: '/en-GB/products',
          at: '2026-09-07T10:00:00.000Z',
        },
        last: {
          utm_source: 'google',
          utm_medium: 'cpc',
          utm_campaign: null,
          utm_term: null,
          utm_content: null,
          ref: null,
          referrer: null,
          landing_path: '/en-GB',
          at: '2026-09-14T09:30:00.000Z',
        },
        captured_at: '2026-09-14T09:30:00.000Z',
      },
    });
  });

  it('sends nothing at all when there is no attribution', () => {
    expect(metadataFor(null)).toBeUndefined();
  });

  it('carries no PII: only campaign fields, a referral code, an origin and a path', () => {
    const touch = touchFrom('utm_source=news&ref=jane', {
      referrer: 'https://news.example.com/x?email=someone%40example.com&name=Jane',
    })!;
    const serialised = JSON.stringify(metadataFor(mergeAttribution(null, touch)));

    expect(serialised).not.toContain('someone@example.com');
    expect(serialised).not.toContain('someone%40example.com');
    expect(serialised).not.toContain('Jane');
    expect(Object.keys(touch).sort()).toEqual([
      'at',
      'landing_path',
      'ref',
      'referrer',
      'utm_campaign',
      'utm_content',
      'utm_medium',
      'utm_source',
      'utm_term',
    ]);
  });
});

describe('the cookie', () => {
  it('is first-party and named for this storefront', () => {
    expect(ATTRIBUTION_COOKIE).toBe('sf_attribution');
  });
});

/**
 * #102. A browser drops an oversized cookie without a word — no exception, no log, nothing in a
 * dashboard — so attribution would silently stop existing. The ceiling is therefore a property of
 * `mergeAttribution`, proven at the worst case rather than assumed from typical inputs.
 */
describe('the cookie size ceiling (#102)', () => {
  /** Every field at its maximum length, in characters that percent-encode to three bytes each. */
  const worstCaseQuery = new URLSearchParams(
    Object.fromEntries(
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'].map((key) => [
        key,
        '€'.repeat(500),
      ]),
    ),
  );

  function worstCaseTouch(now: Date) {
    return readTouch(worstCaseQuery, {
      referrer: `https://${'ä'.repeat(200)}.example.com/path`,
      path: `/en-GB/${'ü'.repeat(500)}`,
      siteOrigin: SITE,
      now,
    })!;
  }

  it('keeps the serialised cookie under the browser limit at the worst case', () => {
    const merged = mergeAttribution(
      mergeAttribution(null, worstCaseTouch(AT)),
      worstCaseTouch(LATER),
    )!;

    expect(attributionCookieBytes(merged)).toBeLessThanOrEqual(ATTRIBUTION_COOKIE_MAX_BYTES);
    expect(ATTRIBUTION_COOKIE_MAX_BYTES).toBeLessThan(4096);
  });

  it('is still valid, parseable attribution after being capped', () => {
    const merged = mergeAttribution(null, worstCaseTouch(AT))!;
    const roundTripped = parseAttribution(JSON.stringify(merged));

    expect(roundTripped).not.toBeNull();
    expect(roundTripped!.first.at).toBe(AT.toISOString());
  });

  it('sacrifices the last touch before the first: first touch is what acquired the customer', () => {
    const first = touchFrom('utm_source=newsletter&utm_campaign=spring');
    const merged = mergeAttribution(mergeAttribution(null, first), worstCaseTouch(LATER))!;

    // The modest first touch survives intact; the enormous last one is what gets reduced.
    expect(merged.first).toEqual(first);
    expect(attributionCookieBytes(merged)).toBeLessThanOrEqual(ATTRIBUTION_COOKIE_MAX_BYTES);
  });

  it('keeps the campaign identity even when it has to reduce a touch', () => {
    const merged = mergeAttribution(null, worstCaseTouch(AT))!;

    // Whatever was dropped, what the touch is *for* — the campaign — is still there.
    expect(merged.last.utm_source).not.toBeNull();
    expect(merged.last.utm_campaign).not.toBeNull();
  });

  it('leaves an ordinary touch completely untouched', () => {
    const touch = touchFrom('utm_source=newsletter&utm_medium=email&utm_campaign=spring');
    expect(mergeAttribution(null, touch)).toEqual({
      first: touch,
      last: touch,
      captured_at: touch!.at,
    });
  });
});
