import { schemaTypes, validateDocument } from '@platform/cms';
import type { CmsDocument, LegalDocument, PageDocument } from '@platform/cms';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, text } from './cms-render';
import LegalPage from '@/app/[locale]/(content)/legal/[slug]/page';
import ContentPage from '@/app/[locale]/(content)/pages/[slug]/page';
import { HomeContent } from '@/lib/cms/components';
import type * as ContentModule from '@/lib/cms/content';
import { getProduct } from '@/lib/catalog';
import { createContentContext, getContent } from '@/lib/cms/content';
import type { CmsReader } from '@/lib/cms/reader';

/**
 * Brand A's real CMS content — task 2.3, issue #141.
 *
 * The acceptance criterion is that every `(content)` route renders **real documents** and that
 * empty-state fallbacks are never shown for production data. So this suite reads the actual JSON
 * that `cms/brand-a/scripts/seed-content.mjs` pushes to the dataset, feeds it through the real route
 * components, and asserts what comes out — no fixtures, no invented documents.
 *
 * It needs no Sanity credentials: `CmsReader` is an interface, so the documents are served from
 * disk. That is the whole reason the content is authored as JSON rather than created by hand in the
 * Studio — content that only exists in a hosted dataset cannot be tested in CI at all.
 */

vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));
vi.mock('@/lib/catalog', () => ({ getProduct: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/cms/content', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentModule>()),
  getContent: vi.fn(),
}));

const CONTENT_DIR = new URL('../../../../cms/brand-a/content/', import.meta.url);

/** Every authored document, exactly as the seed script reads them. */
const documents: CmsDocument[] = readdirSync(CONTENT_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap((f) => JSON.parse(readFileSync(new URL(f, CONTENT_DIR), 'utf8')) as CmsDocument[]);

const LOCALES = ['en-GB', 'de-DE'] as const;
/** The EU set issue #141 names. */
const LEGAL_KINDS = ['imprint', 'privacy', 'terms', 'returns'] as const;

const byType = <T extends CmsDocument['_type']>(type: T) =>
  documents.filter((d): d is Extract<CmsDocument, { _type: T }> => d._type === type);

const IMAGES = { projectId: 'abc', dataset: 'brand-a' };

function readerFor(locale: string): CmsReader {
  const find = <T extends CmsDocument>(list: T[], slug: string) =>
    list.find(
      (d) => d.locale === locale && (d as { slug?: { current: string } }).slug?.current === slug,
    ) ?? null;

  return {
    preview: false,
    dataset: 'brand-a',
    page: async (_l, slug) => find(byType('page'), slug),
    campaignLanding: async (_l, slug) => find(byType('campaignLanding'), slug),
    legal: async (_l, slug) => find(byType('legal'), slug),
    navigation: async () => byType('navigation').find((d) => d.locale === locale) ?? null,
    footer: async () => byType('footer').find((d) => d.locale === locale) ?? null,
    pageSlugs: async () =>
      byType('page')
        .filter((d) => d.locale === locale)
        .map((d) => d.slug.current),
    legalSlugs: async () =>
      byType('legal')
        .filter((d) => d.locale === locale)
        .map((d) => d.slug.current),
  };
}

function useCms(locale: string) {
  const cms = readerFor(locale);
  const ctx = createContentContext({ locale, images: IMAGES });
  vi.mocked(getContent).mockResolvedValue({ cms, ctx });
  return ctx;
}

const params = (locale: string, slug: string) => Promise.resolve({ locale, slug });

/** The product the home page's `productStory` block points at; without it the block renders its own
 * "not available" state, which is a harness artefact rather than anything about the content. */
const CLASSIC_TEE = {
  handle: 'classic-tee',
  title: 'Classic Tee',
  variants: [{ price: { amount_minor: 1999, currency: 'EUR' }, compare_at_price: null }],
} as unknown as Awaited<ReturnType<typeof getProduct>>;

beforeEach(() => {
  vi.mocked(getContent).mockReset();
  vi.mocked(getProduct).mockReset();
  vi.mocked(getProduct).mockResolvedValue(CLASSIC_TEE);
});

describe("the content is valid against window 6's schemas", () => {
  it('has documents at all — an empty glob would make every test below vacuous', () => {
    expect(documents.length).toBeGreaterThanOrEqual(20);
  });

  it.each(
    // Named per document so a failure says which one, not "1 of 20 failed".
    documents.map((d) => [d._id, d] as const),
  )('%s passes validateDocument', async (_id, document) => {
    const errors = await validateDocument(
      document as unknown as Record<string, unknown>,
      schemaTypes,
    );
    expect(errors).toEqual([]);
  });

  it('uses the deterministic id scheme, so a re-seed updates rather than duplicates', () => {
    for (const d of documents) {
      const slugOrKey =
        (d as { slug?: { current: string } }).slug?.current ??
        (d as { key?: string }).key ??
        'default';
      expect(d._id).toBe(`${d._type}.${d.locale}.${slugOrKey}`);
    }
  });
});

describe('both locales are complete', () => {
  it.each(LOCALES)('%s has a home page, navigation and a footer', (locale) => {
    expect(byType('page').some((d) => d.locale === locale && d.slug.current === 'home')).toBe(true);
    expect(byType('navigation').some((d) => d.locale === locale)).toBe(true);
    expect(byType('footer').some((d) => d.locale === locale)).toBe(true);
  });

  it.each(LOCALES)('%s has all four EU legal pages', (locale) => {
    const kinds = byType('legal')
      .filter((d) => d.locale === locale)
      .map((d) => d.kind)
      .sort();
    expect(kinds).toEqual([...LEGAL_KINDS].sort());
  });

  it('translates every document — no locale has a page the other lacks', () => {
    const slugsFor = (locale: string) =>
      documents
        .filter((d) => d.locale === locale)
        .map(
          (d) => `${d._type}:${(d as { slug?: { current: string } }).slug?.current ?? 'default'}`,
        )
        .sort();
    expect(slugsFor('en-GB')).toEqual(slugsFor('de-DE'));
  });

  it('writes genuine German, not copied English', () => {
    // A de-DE document identical to its en-GB twin means a translation was forgotten.
    for (const de of documents.filter((d) => d.locale === 'de-DE')) {
      const en = documents.find((d) => d._id === de._id.replace('de-DE', 'en-GB'));
      expect(en, `no en-GB twin for ${de._id}`).toBeDefined();
      const strip = (d: CmsDocument) => JSON.stringify(d).replace(/de-DE|en-GB/g, '');
      expect(strip(de), `${de._id} is identical to its English twin`).not.toBe(strip(en!));
    }
  });
});

describe('the legal copy is honest about what it is', () => {
  const legal = byType('legal');
  const PLACEHOLDER = /\[\[[A-Z_]+\]\]/g;

  it('never invents a statutory value — every gap is a marked placeholder', () => {
    // The discipline: no fabricated registration numbers, VAT ids or company names. Anything a
    // lawyer must supply is left in a form nobody can mistake for real, and this is what keeps it
    // that way — a placeholder quietly replaced with a plausible-looking value fails here.
    const body = JSON.stringify(legal);
    for (const found of body.match(PLACEHOLDER) ?? []) {
      expect(found).toMatch(/^\[\[[A-Z_]+\]\]$/);
    }
    // Nothing that looks like a real German register or VAT number may appear.
    expect(body).not.toMatch(/HRB\s*\d/);
    expect(body).not.toMatch(/DE\d{9}/);
  });

  it('places holders for the fields §5 DDG and the GDPR actually require', () => {
    const imprint = legal.filter((d) => d.kind === 'imprint');
    for (const d of imprint) {
      const body = JSON.stringify(d);
      for (const field of [
        'COMPANY_LEGAL_NAME',
        'REGISTER_COURT',
        'REGISTER_NUMBER',
        'VAT_ID',
        'RESPONSIBLE_PERSON',
      ]) {
        expect(body, `${d._id} is missing [[${field}]]`).toContain(`[[${field}]]`);
      }
    }
    for (const d of legal.filter((x) => x.kind === 'privacy')) {
      expect(JSON.stringify(d)).toContain('[[SUPERVISORY_AUTHORITY]]');
    }
  });

  it('states the statutory withdrawal period, which is fourteen days and not ours to change', () => {
    for (const d of legal.filter((x) => x.kind === 'returns')) {
      const raw = JSON.stringify(d).toLowerCase();
      expect(raw).toMatch(/fourteen|vierzehn/);
      // Our own thirty-day promise must be presented as additional, never as a replacement.
      expect(raw).toMatch(/thirty|dreißig/);
    }
  });

  it('records when each legal document was last reviewed', () => {
    for (const d of legal) expect(d.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('every internal link resolves', () => {
  /** App routes that exist in code rather than in the CMS. */
  const APP_ROUTES = [/^\/products$/, /^\/products\/[\w-]+$/, /^\/categories\/[\w-]+$/];

  function hrefs(value: unknown, found: string[] = []): string[] {
    if (Array.isArray(value)) for (const v of value) hrefs(v, found);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'href' && typeof v === 'string') found.push(v);
        else hrefs(v, found);
      }
    }
    return found;
  }

  it.each(LOCALES)(
    '%s: no navigation or footer link points at a page that does not exist',
    (locale) => {
      const chrome = documents.filter(
        (d) => d.locale === locale && (d._type === 'navigation' || d._type === 'footer'),
      );
      const pageSlugs = byType('page')
        .filter((d) => d.locale === locale)
        .map((d) => d.slug.current);
      const legalSlugs = byType('legal')
        .filter((d) => d.locale === locale)
        .map((d) => d.slug.current);

      for (const href of hrefs(chrome)) {
        const resolved =
          APP_ROUTES.some((r) => r.test(href)) ||
          pageSlugs.some((s) => href === `/pages/${s}`) ||
          legalSlugs.some((s) => href === `/legal/${s}`);
        expect(resolved, `${locale}: ${href} resolves to nothing`).toBe(true);
      }
    },
  );
});

describe('the routes render the real documents', () => {
  /**
   * The actual empty-state strings, read from the route's own message catalogue rather than guessed.
   *
   * The first version of this test invented a list (`'notFound'`, `'No content'`, `'Nothing here'`)
   * and promptly failed against real copy: the home hero says "Nothing here is designed to be
   * replaced next season." A fallback check that does not read the fallbacks is not a check.
   */
  const emptyStates = (locale: string): string[] => {
    const messages = JSON.parse(
      readFileSync(new URL(`../src/lib/cms/messages/${locale}.json`, import.meta.url), 'utf8'),
    ) as { page: { notFound: { title: string; body: string } } };
    return [messages.page.notFound.title, messages.page.notFound.body];
  };

  it.each(LOCALES)('%s: the empty-state strings were actually found', (locale) => {
    // Every assertion below is `not.toContain(...)` over this list. An empty list would make all of
    // them pass without checking anything.
    const states = emptyStates(locale);
    expect(states).toHaveLength(2);
    for (const state of states) expect(state.length).toBeGreaterThan(5);
  });

  it.each(LOCALES)('%s home renders the authored hero and blocks', async (locale) => {
    const ctx = useCms(locale);
    const home = byType('page').find((d) => d.locale === locale && d.slug.current === 'home');
    const out = await render(HomeContent({ page: home as PageDocument, ctx }));
    const body = text(out);

    expect(body).toContain(home!.hero!.headline);
    expect(body.length).toBeGreaterThan(200);
    for (const empty of emptyStates(locale)) expect(body).not.toContain(empty);
  });

  it.each(LOCALES)('%s renders every authored content page', async (locale) => {
    for (const page of byType('page').filter(
      (d) => d.locale === locale && d.slug.current !== 'home',
    )) {
      useCms(locale);
      const out = await render(await ContentPage({ params: params(locale, page.slug.current) }));
      const body = text(out);
      expect(body, `${page._id}`).toContain(page.title);
      for (const empty of emptyStates(locale)) expect(body).not.toContain(empty);
    }
  });

  it.each(LOCALES)('%s renders every legal page with its real body', async (locale) => {
    for (const doc of byType('legal').filter((d) => d.locale === locale)) {
      useCms(locale);
      const out = await render(await LegalPage({ params: params(locale, doc.slug.current) }));
      const body = text(out);
      expect(body, `${doc._id}`).toContain(doc.title);
      // The first heading of the authored body must actually be on the page.
      const firstHeading = (doc as LegalDocument).body.content.find(
        (b) => (b as { style?: string }).style === 'h2',
      ) as { children?: { text: string }[] } | undefined;
      if (firstHeading?.children?.[0]) {
        expect(body).toContain(firstHeading.children[0].text);
      }
      for (const empty of emptyStates(locale)) expect(body).not.toContain(empty);
    }
  });

  it('404s for a slug nobody authored, rather than rendering an empty shell', async () => {
    useCms('en-GB');
    await expect(ContentPage({ params: params('en-GB', 'does-not-exist') })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });
});
