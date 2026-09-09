import {
  campaignLandingFixture,
  footerFixture,
  legalFixture,
  navigationFixture,
  pageFixture,
} from '@platform/cms';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAll, headingLevels, render, text } from './cms-render';
import ContentLayout from '@/app/[locale]/(content)/layout';
import LegalPage, {
  generateMetadata as legalMetadata,
} from '@/app/[locale]/(content)/legal/[slug]/page';
import ContentNotFound from '@/app/[locale]/(content)/not-found';
import ContentPage, {
  generateMetadata as pageMetadata,
} from '@/app/[locale]/(content)/pages/[slug]/page';
import {
  HomeContent,
  PreviewBanner,
  SanityImage,
  parseAssetRef,
  sanityImageUrl,
} from '@/lib/cms/components';
import type * as ContentModule from '@/lib/cms/content';
import { createContentContext, getContent } from '@/lib/cms/content';
import { documentMetadata } from '@/lib/cms/metadata';
import type { CmsReader } from '@/lib/cms/reader';
import { getProduct } from '@/lib/catalog';
import type { Product, Store } from '@/lib/store-api';

vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));
vi.mock('@/lib/catalog', () => ({ getProduct: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'de-DE' }));
vi.mock('@/lib/store', () => ({ getStoreOrNull: async () => STORE }));
vi.mock('@/lib/cms/content', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentModule>()),
  getContent: vi.fn(),
}));

const STORE = {
  name: 'Brand A',
  code: 'brand-a',
  locales: ['en-GB', 'de-DE'],
} as unknown as Store;

const PRODUCT = {
  handle: 'alpine-backpack',
  title: 'Alpine Backpack',
  variants: [{ price: { amount_minor: 12900, currency: 'EUR' }, compare_at_price: null }],
} as unknown as Product;

const IMAGES = { projectId: 'abc', dataset: 'brand-a' };

function reader(overrides: Partial<CmsReader> = {}): CmsReader {
  return {
    preview: false,
    dataset: 'brand-a',
    page: async () => null,
    campaignLanding: async () => null,
    legal: async () => null,
    navigation: async () => null,
    footer: async () => null,
    pageSlugs: async () => [],
    legalSlugs: async () => [],
    ...overrides,
  };
}

function useCms(locale: string, cms: CmsReader, preview = false) {
  const ctx = createContentContext({ locale, images: IMAGES, preview });
  vi.mocked(getContent).mockResolvedValue({ cms, ctx });
  return ctx;
}

const params = (locale: string, slug: string) => Promise.resolve({ locale, slug });

beforeEach(() => {
  vi.mocked(getProduct).mockReset();
  vi.mocked(getProduct).mockResolvedValue(PRODUCT);
});

describe('/pages/[slug]', () => {
  it('renders every block type from the fixture, with one h1 and no skipped heading levels', async () => {
    useCms('en-GB', reader({ page: async () => pageFixture }));
    const tree = await render(await ContentPage({ params: params('en-GB', 'about') }));

    const h1 = findAll(tree, 'h1');
    expect(h1).toHaveLength(1);
    expect(text(h1[0]!)).toBe(pageFixture.hero!.headline);
    const h2 = findAll(tree, 'h2').map((h) => text(h));
    expect(h2).toEqual(['How we make things', 'The pack that started it all']);
    const levels = headingLevels(tree);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1)
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);

    // richText paragraph, image block with caption, product story with live product, closing CTA
    expect(text(tree)).toContain('guaranteed for ten years');
    expect(text(findAll(tree, 'figcaption'))).toBe('The workshop, spring 2026');
    expect(text(tree)).toContain('Alpine Backpack');
    expect(text(tree)).toContain('View product');
    const links = findAll(tree, 'a').map((a) => a.props['href']);
    expect(links).toContain('/products');
    expect(links).toContain('/products/alpine-backpack');
    expect(vi.mocked(getProduct)).toHaveBeenCalledWith('alpine-backpack');
  });

  it('gives every image alt text and a CDN url for the store dataset', async () => {
    useCms('en-GB', reader({ page: async () => pageFixture }));
    const tree = await render(await ContentPage({ params: params('en-GB', 'about') }));
    const images = findAll(tree, 'img');
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const img of images) {
      expect(typeof img.props['alt']).toBe('string');
      expect((img.props['alt'] as string).length).toBeGreaterThan(0);
      expect(String(img.props['src'])).toMatch(
        /^https:\/\/cdn\.sanity\.io\/images\/abc\/brand-a\/placeholder-1x1\.png\?/,
      );
      expect(img.props['width']).toBe(1);
      expect(img.props['loading']).toMatch(/lazy|eager/);
    }
  });

  it('degrades a product story to its copy when the product cannot be loaded', async () => {
    vi.mocked(getProduct).mockRejectedValue(new Error('404'));
    useCms('en-GB', reader({ page: async () => pageFixture }));
    const tree = await render(await ContentPage({ params: params('en-GB', 'about') }));
    expect(text(tree)).toContain('The pack that started it all');
    expect(text(tree)).toContain('This product is not available right now.');
    expect(text(tree)).not.toContain('Alpine Backpack');
  });

  it('is a 404 when the CMS has nothing, with a translated title', async () => {
    useCms('en-GB', reader());
    await expect(ContentPage({ params: params('en-GB', 'missing') })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(await pageMetadata({ params: params('en-GB', 'missing') })).toEqual({
      title: 'Page not found',
    });
  });

  it('builds metadata from the seo fields, canonical and hreflang', async () => {
    useCms('en-GB', reader({ page: async () => pageFixture }));
    const metadata = await pageMetadata({ params: params('en-GB', 'about') });
    expect(metadata.title).toBe('About Brand A');
    expect(metadata.description).toBe(pageFixture.seo!.metaDescription);
    expect(metadata.alternates?.canonical).toBe('/en-GB/pages/about');
    expect(metadata.alternates?.languages).toMatchObject({ 'en-GB': '/en-GB/pages/about' });
    expect(metadata.robots).toBeUndefined();

    const ctx = createContentContext({ locale: 'en-GB', images: IMAGES });
    const campaign = documentMetadata(campaignLandingFixture, '/campaign/spring-sale', ctx);
    expect(campaign.robots).toEqual({ index: false, follow: false });
    const withImage = documentMetadata(
      { title: 'x', seo: { ogImage: pageFixture.hero!.image! } },
      '/pages/x',
      ctx,
    );
    expect(withImage.openGraph?.images).toEqual([
      {
        url: expect.stringContaining('cdn.sanity.io/images/abc/brand-a/'),
        alt: pageFixture.hero!.image!.alt,
      },
    ]);
  });
});

describe('/legal/[slug] and the locale switch', () => {
  it('renders the legal page in the request language', async () => {
    useCms('en-GB', reader({ legal: async () => legalFixture }));
    const en = await render(await LegalPage({ params: params('en-GB', 'privacy') }));
    expect(text(findAll(en, 'h1'))).toBe('Privacy policy');
    expect(text(en)).toContain('Last reviewed 1 September 2026');
    expect(findAll(en, 'h2').map((h) => text(h))).toEqual(['What we collect']);

    useCms('de-DE', reader({ legal: async () => ({ ...legalFixture, locale: 'de-DE' }) }));
    const de = await render(await LegalPage({ params: params('de-DE', 'privacy') }));
    expect(text(de)).toContain('Datenschutzerklärung');
    expect(text(de)).toContain('Zuletzt geprüft am 1. September 2026');
    expect(text(de)).not.toContain('Last reviewed');

    expect((await legalMetadata({ params: params('de-DE', 'privacy') })).title).toBe(
      'Privacy policy',
    );
  });

  it('404s an unknown legal page', async () => {
    useCms('en-GB', reader());
    await expect(LegalPage({ params: params('en-GB', 'nope') })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await legalMetadata({ params: params('en-GB', 'nope') })).toEqual({
      title: 'Page not found',
    });
  });

  it('translates the not-found page from the request locale', async () => {
    const tree = await render(await ContentNotFound());
    expect(text(findAll(tree, 'h1'))).toBe('Seite nicht gefunden');
    expect(text(tree)).toContain('Zurück zur Startseite');
  });
});

describe('(content) layout: navigation and footer', () => {
  it('falls back to the static links and copyright when the CMS is empty', async () => {
    useCms('en-GB', reader());
    const tree = await render(
      await ContentLayout({ children: 'BODY', params: Promise.resolve({ locale: 'en-GB' }) }),
    );
    const nav = findAll(tree, 'nav')[0]!;
    expect(nav.props['aria-label']).toBe('Main');
    expect(findAll([nav], 'a').map((a) => [a.props['href'], text(a)])).toEqual([
      ['/products', 'Shop'],
      ['/pages/about', 'About'],
    ]);
    expect(text(findAll(tree, 'header'))).toContain('Account');
    expect(text(findAll(tree, 'footer'))).toBe(`© ${new Date().getFullYear()} Brand A`);
    expect(findAll(tree, 'main').map((m) => text(m))).toEqual(['BODY']);
    expect(findAll(tree, '[role=status]')).toEqual([]);

    useCms('de-DE', reader());
    const de = await render(
      await ContentLayout({ children: null, params: Promise.resolve({ locale: 'de-DE' }) }),
    );
    expect(text(findAll(de, 'nav')[0]!)).toContain('Über uns');
    expect(findAll(de, 'nav')[0]!.props['aria-label']).toBe('Hauptnavigation');
  });

  it('renders the CMS navigation and footer documents when published', async () => {
    useCms(
      'en-GB',
      reader({ navigation: async () => navigationFixture, footer: async () => footerFixture }),
    );
    const tree = await render(
      await ContentLayout({ children: null, params: Promise.resolve({ locale: 'en-GB' }) }),
    );
    const nav = findAll(tree, 'nav')[0]!;
    expect(findAll([nav], 'a').map((a) => text(a))).toEqual([
      'Shop',
      'Bags',
      'Backpacks',
      'Totes',
      'About',
    ]);
    const footer = findAll(tree, 'footer')[0]!;
    expect(findAll([footer], 'h2').map((h) => text(h))).toEqual([
      'Shop',
      'Help',
      'Legal',
      'Follow us',
    ]);
    const instagram = findAll([footer], 'a').find((a) => text(a) === 'Instagram')!;
    expect(instagram.props).toMatchObject({
      href: 'https://instagram.com/brand-a',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(text(footer)).toContain('© 2026 Brand A B.V.');
  });

  it('shows the preview banner only in preview mode', async () => {
    const preview = createContentContext({ locale: 'en-GB', preview: true });
    const shown = await render(PreviewBanner({ ctx: preview, returnTo: '/en-GB/pages/about' }));
    expect(findAll(shown, 'div')[0]?.props['role']).toBe('status');
    expect(findAll(shown, 'a')[0]?.props['href']).toBe(
      '/api/cms/preview/exit?redirect=%2Fen-GB%2Fpages%2Fabout',
    );
    expect(text(shown)).toContain('Exit preview');
    const hidden = await render(
      PreviewBanner({ ctx: createContentContext({ locale: 'en-GB' }), returnTo: '/' }),
    );
    expect(hidden).toEqual([]);
  });
});

describe('home slots and images', () => {
  it('renders nothing without a home page, and never an h1 with one', async () => {
    const ctx = createContentContext({ locale: 'en-GB', images: IMAGES });
    expect(await render(HomeContent({ page: null, ctx }))).toEqual([]);
    const tree = await render(HomeContent({ page: pageFixture, ctx }));
    expect(findAll(tree, 'h1')).toEqual([]);
    expect(text(findAll(tree, 'h2')[0]!)).toBe(pageFixture.hero!.headline);
  });

  it('builds CDN urls from asset refs and renders nothing without an image source', async () => {
    expect(parseAssetRef('image-abc123-1200x800-jpg')).toEqual({
      id: 'abc123',
      width: 1200,
      height: 800,
      format: 'jpg',
    });
    expect(parseAssetRef('file-abc-pdf')).toBeNull();
    expect(sanityImageUrl(IMAGES, 'image-abc123-1200x800-jpg', { width: 600 })).toBe(
      'https://cdn.sanity.io/images/abc/brand-a/abc123-1200x800.jpg?auto=format&fit=max&w=600',
    );
    expect(sanityImageUrl(IMAGES, 'garbage')).toBeNull();
    const noSource = createContentContext({ locale: 'en-GB' });
    expect(await render(SanityImage({ image: pageFixture.hero!.image!, ctx: noSource }))).toEqual(
      [],
    );
  });
});

/**
 * The acceptance criterion "every string in (content) goes through next-intl": no JSX text and no
 * user-facing attribute literal in the content routes or the CMS components. Same idea as the
 * `(shop)`/`(checkout)` scanner in `i18n.test.ts`, kept separately because that file is window 3's.
 */
describe('no hard-coded strings in (content) and the CMS components', () => {
  const roots = [
    join(process.cwd(), 'src', 'app', '[locale]', '(content)'),
    join(process.cwd(), 'src', 'lib', 'cms', 'components'),
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.tsx')) files.push(full);
    }
  };
  roots.forEach(walk);

  it('finds the files it is supposed to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it('finds none', () => {
    const offenders: string[] = [];
    const jsxText = />\s*[^<>{}]*[A-Za-z]{2,}[^<>{}]*</;
    const attribute = /\b(aria-label|title|alt|placeholder)="[^"]*[A-Za-z]{2,}[^"]*"/;
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
            return;
          if (jsxText.test(line) || attribute.test(line)) {
            offenders.push(`${file.split(/[\\/]/).pop()}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
