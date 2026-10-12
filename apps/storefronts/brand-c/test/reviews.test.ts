import { describe, expect, it, vi } from 'vitest';
import { ProductReviews } from '@/components/product-reviews';
import {
  fromProductMetadata,
  parseReview,
  parseReviews,
  sortNewestFirst,
  summarise,
  type Review,
} from '@/lib/reviews';
import type { Product } from '@/lib/store-api';

/**
 * The PDP review block (task 2.4). Reviews are customer-authored text arriving from outside the
 * contract, so the parsing is strict; and the block renders nothing at all when there is nothing,
 * because an empty "no reviews yet" panel on a new catalogue announces that nobody has bought.
 */

vi.mock('next-intl/server', () => ({
  // The catalogue itself is covered by test/i18n.test.ts; here only the shape matters.
  getTranslations: async (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values === undefined ? `${namespace}.${key}` : `${namespace}.${key}:${JSON.stringify(values)}`,
}));

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-alpha',
    rating: 5,
    title: 'Excellent',
    body: 'Wore it all summer.',
    author: 'Ada',
    created_at: '2026-09-01T10:00:00.000Z',
    verified_purchase: true,
    ...overrides,
  };
}

describe('parseReview', () => {
  it('accepts a well-formed record', () => {
    expect(parseReview(review())).toEqual(review());
  });

  it('drops a record with no id or no usable rating', () => {
    // Rendering "undefined stars" is worse than a shorter list.
    expect(parseReview({ ...review(), id: '' })).toBeNull();
    expect(parseReview({ ...review(), rating: undefined })).toBeNull();
    expect(parseReview({ ...review(), rating: '5' })).toBeNull();
    expect(parseReview({ ...review(), rating: 0 })).toBeNull();
    expect(parseReview({ ...review(), rating: 7 })).toBeNull();
    expect(parseReview({ ...review(), rating: Number.NaN })).toBeNull();
    expect(parseReview(null)).toBeNull();
    expect(parseReview('a review')).toBeNull();
  });

  it('normalises the optional text fields to null rather than empty strings', () => {
    const parsed = parseReview({ ...review(), title: '   ', body: '', author: undefined });
    expect(parsed).toMatchObject({ title: null, body: null, author: null });
  });

  it('treats verified_purchase as true only when it really is', () => {
    expect(parseReview({ ...review(), verified_purchase: 'yes' })?.verified_purchase).toBe(false);
    expect(parseReview({ ...review(), verified_purchase: 1 })?.verified_purchase).toBe(false);
  });
});

describe('parseReviews', () => {
  it('keeps the good records and drops the bad ones', () => {
    expect(
      parseReviews([review(), { nonsense: true }, review({ id: 'b' })]).map((r) => r.id),
    ).toEqual(['review-alpha', 'b']);
  });

  it('is empty for anything that is not an array', () => {
    for (const value of [undefined, null, {}, 'reviews', 3]) {
      expect(parseReviews(value)).toEqual([]);
    }
  });
});

describe('fromProductMetadata', () => {
  it('reads attributes.reviews, the only source until the contract has a review shape', () => {
    const product = { attributes: { reviews: [review()] } } as unknown as Product;
    expect(fromProductMetadata(product)).toHaveLength(1);
  });

  it('is empty when the product carries nothing, rather than throwing', () => {
    expect(fromProductMetadata({ attributes: {} } as unknown as Product)).toEqual([]);
    expect(fromProductMetadata({} as unknown as Product)).toEqual([]);
  });
});

describe('summarise and ordering', () => {
  it('averages to one decimal place', () => {
    expect(
      summarise([review({ rating: 5 }), review({ rating: 4 }), review({ rating: 4 })]),
    ).toEqual({
      count: 3,
      average: 4.3,
    });
  });

  it('has no average at all when there are no reviews — never 0 out of 5', () => {
    expect(summarise([])).toEqual({ count: 0, average: null });
  });

  it('orders newest first and does not mutate its input', () => {
    const input = [
      review({ id: 'old', created_at: '2026-01-01T00:00:00.000Z' }),
      review({ id: 'new', created_at: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(sortNewestFirst(input).map((r) => r.id)).toEqual(['new', 'old']);
    expect(input.map((r) => r.id)).toEqual(['old', 'new']);
  });
});

/** An async server component: call it and walk the returned tree — no DOM needed. */
async function render(reviews: Review[]) {
  return (await ProductReviews({ reviews })) as unknown;
}

function flatten(node: unknown, out: { type: unknown; props: Record<string, unknown> }[] = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === undefined) return out;

  const props = element.props ?? {};
  out.push({ type: element.type, props });
  // Synchronous child components are invoked so their own markup is walked too — otherwise a
  // decorative element inside one (the rating stars) is invisible to these assertions.
  if (typeof element.type === 'function') {
    const rendered = (element.type as (p: Record<string, unknown>) => unknown)(props);
    if (!(rendered instanceof Promise)) flatten(rendered, out);
  }
  flatten(props.children, out);
  return out;
}

describe('ProductReviews', () => {
  it('renders nothing when there is no data', async () => {
    expect(await render([])).toBeNull();
  });

  it('renders a labelled section and one article per review when given fixtures', async () => {
    const nodes = flatten(await render([review(), review({ id: 'b', rating: 3 })]));

    const section = nodes.find((node) => node.type === 'section');
    expect(section?.props['aria-labelledby']).toBe('reviews');
    // The heading the section points at must exist, or the label refers to nothing.
    expect(nodes.some((node) => node.type === 'h2' && node.props.id === 'reviews')).toBe(true);
    expect(nodes.filter((node) => node.type === 'article')).toHaveLength(2);
    expect(nodes.filter((node) => node.type === 'li')).toHaveLength(2);
  });

  it('states the rating as text and hides the stars from assistive technology', async () => {
    const nodes = flatten(await render([review({ rating: 4 })]));

    // A screen reader should hear "4 out of 5", not "star star star star".
    const stars = nodes.filter((node) => node.props['aria-hidden'] === 'true');
    expect(stars.length).toBeGreaterThan(0);
    const text = JSON.stringify(nodes.map((node) => node.props.children));
    expect(text).toContain('pdp.reviews.rating');
    expect(text).toContain('"rating":4');
  });

  it('gives every date a machine-readable datetime', async () => {
    const nodes = flatten(await render([review()]));
    const time = nodes.find((node) => node.type === 'time');
    expect(time?.props.dateTime).toBe('2026-09-01T10:00:00.000Z');
  });

  it('omits a missing title, body or author instead of rendering an empty element', async () => {
    const nodes = flatten(await render([review({ title: null, body: null, author: null })]));
    expect(nodes.some((node) => node.type === 'h3')).toBe(false);
  });
});
