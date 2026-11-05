import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HEADERS } from '@platform/contracts';
import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import deDE from '../messages/de-DE.json';
import enGB from '../messages/en-GB.json';
import {
  analyticsConsentMode,
  clickedEvent,
  RECOMMENDATION_EVENT_PROPERTIES,
  viewedEvent,
} from '@/lib/analytics/recommendation-events';
import {
  DEFAULT_TIMEOUT_MS,
  EMPTY_RECOMMENDATIONS,
  loadRecommendations,
  MAX_VARIANT_IDS,
  RAIL_LIMIT,
  recommendationsTimeoutMs,
} from '@/lib/recommendations';
import {
  StoreApiClient,
  StoreApiError,
  type ProductSummary,
  type RecommendationList,
} from '@/lib/store-api';

/**
 * #609. The rail is decoration: whatever the recommendations call does — answers, answers empty,
 * 404s, fails, or hangs — the PDP and the cart render, and they render without a rail. These pin
 * that contract at the one place it is enforced (`loadRecommendations`), the request the client
 * builds, the markup the rail renders, and the shape of the two analytics events.
 */

// The locale-aware Link needs Next's router and next/image its loader config; plain elements are
// enough to read the markup.
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => createElement('a', { href, className }, children),
}));
vi.mock('@/components/product-image', () => ({
  ProductImage: ({ src, alt }: { src: string; alt: string }) => createElement('img', { src, alt }),
}));

const { RecommendationRail } = await import('@/components/recommendation-rail');
const { ProductCard } = await import('@/components/product-card');

const CONFIG = { baseUrl: 'http://localhost:4010', publishableKey: 'pk_word' };

function summary(id: string): ProductSummary {
  return {
    id,
    handle: `handle-${id}`,
    title: `Title ${id}`,
    thumbnail_url: `https://picsum.photos/seed/${id}/400/400`,
    price: { amount_minor: 1999, currency: 'EUR' },
    compare_at_price: null,
    category_handle: null,
    tags: [],
  } as ProductSummary;
}

const ITEMS = ['p-one', 'p-two', 'p-three'].map(summary);

function clientAnswering(
  respond: (signal: AbortSignal | undefined) => Promise<RecommendationList>,
) {
  const calls: { query: unknown; options: { signal?: AbortSignal } | undefined }[] = [];
  return {
    calls,
    client: {
      listProductRecommendations: vi.fn(async (query, options) => {
        calls.push({ query, options });
        return respond(options?.signal);
      }),
    } as Pick<StoreApiClient, 'listProductRecommendations'>,
  };
}

const PDP = { surface: 'pdp', productId: 'anchor-product' } as const;

describe('StoreApiClient.listProductRecommendations', () => {
  it('sends the publishable key, no token, and variant_ids as ONE comma-separated value', async () => {
    let seen: { url: string; headers: Headers } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers) };
      return new Response(JSON.stringify({ kind: 'popular', items: [] }), { status: 200 });
    }) as typeof fetch;

    const list = await new StoreApiClient({ ...CONFIG, fetchImpl }).listProductRecommendations({
      kind: 'bought_together',
      variant_ids: ['v-one', 'v-two'],
      limit: 4,
    });

    expect(list.kind).toBe('popular');
    const url = new URL(seen!.url);
    expect(url.pathname).toBe('/store/recommendations');
    expect(url.searchParams.getAll('variant_ids')).toEqual(['v-one,v-two']);
    expect(url.searchParams.get('kind')).toBe('bought_together');
    expect(url.searchParams.get('product_id')).toBeNull();
    expect(seen!.headers.get(HEADERS.publishableKey)).toBe('pk_word');
    expect(seen!.headers.get('authorization')).toBeNull();
  });
});

describe('loadRecommendations — never throws, never waits past its deadline', () => {
  it('passes the SERVED kind through (a popular fallback stays popular) and caps the rail', async () => {
    const many = Array.from({ length: 8 }, (_, index) => summary(`p-${index}`));
    const { client, calls } = clientAnswering(async () => ({ kind: 'popular', items: many }));

    const result = await loadRecommendations(PDP, { client, currency: 'GBP' });

    expect(result.kind).toBe('popular');
    expect(result.items).toHaveLength(RAIL_LIMIT);
    expect(calls[0]!.query).toEqual({
      kind: 'bought_together',
      limit: RAIL_LIMIT,
      product_id: 'anchor-product',
      currency: 'GBP',
    });
  });

  it('an empty answer is an empty rail', async () => {
    const { client } = clientAnswering(async () => ({ kind: 'bought_together', items: [] }));
    expect((await loadRecommendations(PDP, { client })).items).toEqual([]);
  });

  it.each([
    ['404 not_found', new StoreApiError(404, null, null)],
    ['500', new StoreApiError(500, null, null)],
    ['a network error', new TypeError('fetch failed')],
  ])('%s is an empty rail, not an error', async (_, error) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = clientAnswering(async () => Promise.reject(error));
    await expect(loadRecommendations(PDP, { client })).resolves.toEqual(EMPTY_RECOMMENDATIONS);
    warn.mockRestore();
  });

  it('a call that never answers gives up at the deadline and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const { client } = clientAnswering((s) => {
      signal = s;
      return new Promise(() => {});
    });

    const started = Date.now();
    const result = await loadRecommendations(PDP, { client, timeoutMs: 50 });
    const elapsed = Date.now() - started;

    expect(result).toEqual(EMPTY_RECOMMENDATIONS);
    expect(elapsed).toBeLessThan(1000);
    expect(signal?.aborted).toBe(true);
  });

  it('a cart: de-duplicated variant ids, capped at the contract maximum, no request when empty', async () => {
    const { client, calls } = clientAnswering(async () => ({
      kind: 'bought_together',
      items: ITEMS,
    }));
    const ids = Array.from({ length: MAX_VARIANT_IDS + 5 }, (_, index) => `v-${index}`);

    await loadRecommendations({ surface: 'cart', variantIds: [...ids, 'v-0'] }, { client });
    expect((calls[0]!.query as { variant_ids: string[] }).variant_ids).toEqual(
      ids.slice(0, MAX_VARIANT_IDS),
    );

    await expect(
      loadRecommendations({ surface: 'cart', variantIds: [] }, { client }),
    ).resolves.toEqual(EMPTY_RECOMMENDATIONS);
    expect(calls).toHaveLength(1);
  });

  it('RECOMMENDATIONS_TIMEOUT_MS: a positive integer, anything else is the default', () => {
    expect(recommendationsTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(recommendationsTimeoutMs({ RECOMMENDATIONS_TIMEOUT_MS: '800' })).toBe(800);
    for (const bad of ['0', '-5', '1.5', 'soon', ''])
      expect(recommendationsTimeoutMs({ RECOMMENDATIONS_TIMEOUT_MS: bad })).toBe(
        DEFAULT_TIMEOUT_MS,
      );
  });
});

/** React 19 hoists a `<link rel="preload">` for the stand-in `<img>`; the card markup is what counts. */
function render(locale: 'en-GB' | 'de-DE', node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === 'en-GB' ? enGB : deDE,
      timeZone: 'Europe/London',
      children: node,
    }),
  ).replace(/<link rel="preload"[^>]*\/>/g, '');
}

function rail(
  surface: 'pdp' | 'cart',
  recommendations: { kind: 'bought_together' | 'popular' | null; items: ProductSummary[] },
  locale: 'en-GB' | 'de-DE' = 'en-GB',
  tracking = true,
) {
  return render(
    locale,
    createElement(RecommendationRail, { surface, recommendations, locale, tracking }),
  );
}

describe('RecommendationRail', () => {
  it('renders NOTHING when empty or when nothing was served — no heading, no reserved box', () => {
    expect(rail('pdp', { kind: 'bought_together', items: [] })).toBe('');
    expect(rail('cart', EMPTY_RECOMMENDATIONS)).toBe('');
  });

  it('renders each item with the PLP ProductCard, unchanged', () => {
    const html = rail('pdp', { kind: 'bought_together', items: ITEMS });
    for (const product of ITEMS) {
      expect(html).toContain(
        render('en-GB', createElement(ProductCard, { product, locale: 'en-GB' })),
      );
    }
    expect(html.match(/data-rail-position="\d"/g)).toEqual([
      'data-rail-position="1"',
      'data-rail-position="2"',
      'data-rail-position="3"',
    ]);
    expect(html).toContain('data-kind="bought_together"');
  });

  it.each([
    ['pdp', 'en-GB', 'Frequently bought together'],
    ['cart', 'en-GB', 'You may also like'],
    ['pdp', 'de-DE', 'Wird oft zusammen gekauft'],
    ['cart', 'de-DE', 'Das könnte Ihnen auch gefallen'],
  ] as const)('%s heading in %s', (surface, locale, heading) => {
    const html = rail(surface, { kind: 'popular', items: ITEMS }, locale);
    expect(html).toContain(`>${heading}</h2>`);
    expect(html).toContain(`aria-labelledby="recommendations-${surface}"`);
  });

  it('the same markup with and without tracking (the tracker only observes)', () => {
    const tracked = rail('cart', { kind: 'popular', items: ITEMS }, 'en-GB', true);
    const untracked = rail('cart', { kind: 'popular', items: ITEMS }, 'en-GB', false);
    expect(tracked).toBe(`<div>${untracked}</div>`);
  });
});

describe('recommendation events — the local definition until the tracking plan has them', () => {
  const context = { kind: 'popular' as const, surface: 'cart' as const, productIds: ['a', 'b'] };

  it('viewed carries the SERVED kind, the surface and the ids — exactly the defined properties', () => {
    const event = viewedEvent(context);
    expect(event).toEqual({
      event: 'recommendation_viewed',
      kind: 'popular',
      surface: 'cart',
      product_ids: ['a', 'b'],
      count: 2,
    });
    expect(Object.keys(event).sort()).toEqual(
      [...RECOMMENDATION_EVENT_PROPERTIES.recommendation_viewed].sort(),
    );
  });

  it('clicked carries the product and its 1-based position; outside the rail is no event', () => {
    const event = clickedEvent(context, 2);
    expect(event).toMatchObject({ event: 'recommendation_clicked', product_id: 'b', position: 2 });
    expect(Object.keys(event!).sort()).toEqual(
      [...RECOMMENDATION_EVENT_PROPERTIES.recommendation_clicked].sort(),
    );
    expect(clickedEvent(context, 0)).toBeNull();
    expect(clickedEvent(context, 3)).toBeNull();
    expect(clickedEvent(context, Number.NaN)).toBeNull();
  });

  it('no identity of any kind: no customer id, hash, session or cookie', () => {
    const keys = [
      ...RECOMMENDATION_EVENT_PROPERTIES.recommendation_viewed,
      ...RECOMMENDATION_EVENT_PROPERTIES.recommendation_clicked,
    ];
    for (const key of keys) expect(key).not.toMatch(/customer|email|hash|session|user|anonymous/);
  });

  it('consent mode: analytics by default, strict when set, an unknown value throws', () => {
    expect(analyticsConsentMode({})).toBe('analytics');
    expect(analyticsConsentMode({ STOREFRONT_ANALYTICS_CONSENT_MODE: 'strict' })).toBe('strict');
    expect(() => analyticsConsentMode({ STOREFRONT_ANALYTICS_CONSENT_MODE: 'strcit' })).toThrow();
  });
});

describe('STOREFRONT_ANALYTICS_CONSENT_MODE fails the build, not the first render', () => {
  const loadConfig = (value: string) =>
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./next.config.mjs')"],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, STOREFRONT_ANALYTICS_CONSENT_MODE: value },
        encoding: 'utf8',
      },
    );

  it('next.config.mjs refuses an unknown value and loads with a known one', () => {
    const typo = loadConfig('strcit');
    expect(typo.status).not.toBe(0);
    expect(typo.stderr).toContain(
      'STOREFRONT_ANALYTICS_CONSENT_MODE must be one of analytics, strict',
    );
    expect(loadConfig('strict').status).toBe(0);
  }, 30_000);
});
