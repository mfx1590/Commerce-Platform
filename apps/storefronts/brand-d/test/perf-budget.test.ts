import { describe, expect, it } from 'vitest';
import { ProductImage } from '@/components/product-image';
import { cloudinaryImageLoader } from '@platform/ui/image-loader';
import { layoutKeys } from '../scripts/bundle-budget.mjs';
import lighthouserc from '../lighthouserc.json';

/**
 * Task 2.3. The two things here fail silently when wrong: a bundle budget that stops counting a
 * layout under-reports exactly the code a brand grows (header, footer), and an image that takes the
 * wrong loader either 404s or ships an unresized original.
 */

describe('bundle budget — which layouts a page pays for', () => {
  const available = new Set([
    '/[locale]/layout',
    '/[locale]/(shop)/layout',
    '/[locale]/(shop)/products/[handle]/page',
    '/[locale]/(checkout)/layout',
  ]);

  it('includes every layout above the page, outermost first', () => {
    expect(layoutKeys('/[locale]/(shop)/products/[handle]/page', available)).toEqual([
      '/[locale]/layout',
      '/[locale]/(shop)/layout',
    ]);
  });

  it('skips path segments that have no layout of their own', () => {
    // There is no /[locale]/(shop)/products/layout — the page still gets the two above it.
    expect(layoutKeys('/[locale]/(shop)/products/[handle]/page', available)).not.toContain(
      '/[locale]/(shop)/products/layout',
    );
  });

  it('never borrows a sibling route group’s layout', () => {
    expect(layoutKeys('/[locale]/(shop)/products/[handle]/page', available)).not.toContain(
      '/[locale]/(checkout)/layout',
    );
  });
});

describe('ProductImage — the image CDN seam', () => {
  const base = { alt: 'A product', width: 400, height: 400 };

  it('resizes a Cloudinary delivery URL through Cloudinary', () => {
    const element = ProductImage({
      ...base,
      src: 'https://res.cloudinary.com/brand-alpha/image/upload/v1/products/tee.jpg',
    }) as { props: { loader?: unknown } };

    expect(element.props.loader).toBe(cloudinaryImageLoader);
  });

  it('leaves every other host on Next’s default loader, so the optimiser still resizes it', () => {
    // A global custom loader would have switched `/_next/image` off entirely and these would 404.
    for (const src of [
      'https://picsum.photos/seed/brand-a-1/800/1000',
      'https://images.unsplash.com/photo-1',
      '/local/placeholder.png',
    ]) {
      const element = ProductImage({ ...base, src }) as { props: { loader?: unknown } };
      expect(element.props.loader).toBeUndefined();
    }
  });

  it('passes every other prop through untouched', () => {
    const element = ProductImage({
      ...base,
      src: 'https://picsum.photos/seed/brand-a-1/800/1000',
      priority: true,
      sizes: '50vw',
    }) as { props: Record<string, unknown> };

    expect(element.props).toMatchObject({ alt: 'A product', priority: true, sizes: '50vw' });
  });
});

describe('Lighthouse gate — which run a budget is checked against', () => {
  type Assertion = [string, { minScore?: number; aggregationMethod?: string }];
  const assertions = lighthouserc.ci.assert.assertions as unknown as Record<string, Assertion>;

  /**
   * LHCI checks an assertion against the *best* of the runs unless told otherwise. The defect the
   * SEO budget guards (#274: metadata streamed after `</head>`) is absent on run 1 and present on
   * runs 2 and 3, so on the default the old build's 100, 92, 92 passes a 95 budget. The gate was
   * shipped that way once; this is what stops it happening again.
   */
  it('checks SEO against the worst run, at 95 or better', () => {
    const [level, options] = assertions['categories:seo']!;
    expect(level).toBe('error');
    expect(options.aggregationMethod).toBe('pessimistic');
    expect(options.minScore).toBeGreaterThanOrEqual(0.95);
  });

  it('runs each URL more than once, or "the worst run" means nothing', () => {
    expect(lighthouserc.ci.collect.numberOfRuns).toBeGreaterThanOrEqual(3);
  });
});
