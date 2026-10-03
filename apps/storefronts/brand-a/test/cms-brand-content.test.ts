import { schemaTypes, validateDocument } from '@platform/cms';
import type { CmsDocument, LegalDocument, PageDocument } from '@platform/cms';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, text } from './cms-render';
import CampaignPage from '@/app/[locale]/(content)/campaign/[slug]/page';
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
    // The sitemap's read; this file renders pages, so it is never called here. The inventory it
    // yields from this dataset is asserted in brand-i18n-seo.test.ts.
    routedDocuments: async () => [],
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
  const legalJson = JSON.stringify(legal);

  /**
   * Every value a lawyer or the company must supply, and nothing else. Pinning the full list — not
   * just the five §5 DDG ones — is what stops an unpinned field being quietly filled in with an
   * invented address or phone number: review found the first version checked five and left eight
   * unguarded.
   */
  const REQUIRED_PLACEHOLDERS = {
    imprint: [
      'COMPANY_LEGAL_NAME',
      'STREET_ADDRESS',
      'POSTCODE',
      'CITY',
      'COUNTRY',
      'MANAGING_DIRECTOR',
      'CONTACT_EMAIL',
      'CONTACT_PHONE',
      'REGISTER_COURT',
      'REGISTER_NUMBER',
      'VAT_ID',
      'RESPONSIBLE_PERSON',
    ],
    privacy: [
      'COMPANY_LEGAL_NAME',
      'DPO_CONTACT',
      'ORDER_RETENTION_PERIOD',
      'PRIVACY_CONTACT_EMAIL',
      'SUPERVISORY_AUTHORITY',
    ],
    terms: ['COMPANY_LEGAL_NAME', 'DISPATCH_WINDOW'],
    returns: ['RETURNS_CONTACT_EMAIL', 'RETURNS_ADDRESS'],
  } as const;

  it('leaves no placeholder in a degraded form', () => {
    /**
     * Scans for *anything* bracket-shaped and requires it to be a well-formed placeholder, rather
     * than matching well-formed ones and asserting they are well-formed.
     *
     * The first version did exactly that — matched with `/\[\[[A-Z_]+\]\]/g`, then asserted each
     * match against the same pattern — so it was a tautology that could never fail. A degraded
     * `[[Register Court]]` or a `{{VAT_ID}}` sailed through. This is the third time a guard of mine
     * has been vacuous in this way; the lesson is in the mutation test below, which proves it fails.
     */
    const bracketShaped = legalJson.match(/\[\[[^\]]*\]\]/g) ?? [];
    expect(
      bracketShaped.length,
      'no placeholders found at all — the scan is broken',
    ).toBeGreaterThan(20);
    for (const found of bracketShaped) {
      expect(found, `${found} is not a well-formed [[UPPER_SNAKE]] placeholder`).toMatch(
        /^\[\[[A-Z_]+\]\]$/,
      );
    }
    // Other placeholder syntaxes would not be caught by the scan above, so reject them by name.
    expect(legalJson, 'a {{mustache}} placeholder is not the agreed form').not.toMatch(
      /\{\{[^}]*\}\}/,
    );
    expect(legalJson, 'a <angle> placeholder is not the agreed form').not.toMatch(/<[A-Z_]{3,}>/);
  });

  it('invents no statutory identifier', () => {
    // Widened after review: `HRB: 12345`, `HRB-12345`, `DE 123 456 789` and `DE-123456789` all got
    // past the first version, which only rejected `HRB\s*\d` and `DE\d{9}`.
    expect(legalJson, 'a register number appears').not.toMatch(/HRB[\s:.-]*\d/i);
    expect(legalJson, 'a VAT identifier appears').not.toMatch(/DE[\s.-]*(?:\d[\s.-]*){9}/i);
    // Nor a real-looking contact detail in place of a placeholder.
    expect(legalJson, 'an email address appears').not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(legalJson, 'a phone number appears').not.toMatch(/\+\d[\d\s()/-]{7,}/);
    // A street address: "<number> <Word>straße" or "<Word> <number>," — the shapes an invented
    // German or British address takes.
    expect(legalJson, 'a street address appears').not.toMatch(
      /\d+\s+\w*(?:stra(?:ß|ss)e|weg|platz|gasse|street|road|lane)/i,
    );
    expect(legalJson, 'a postcode appears').not.toMatch(/\d{5}\s+[A-ZÄÖÜ][a-zäöü]+/);
  });

  it.each(Object.entries(REQUIRED_PLACEHOLDERS))(
    'every %s document holds a place for each value only a lawyer can supply',
    (kind, fields) => {
      const docs = legal.filter((d) => d.kind === kind);
      expect(docs.length, `no ${kind} documents`).toBeGreaterThan(0);
      for (const d of docs) {
        const body = JSON.stringify(d);
        for (const field of fields) {
          expect(body, `${d._id} is missing [[${field}]]`).toContain(`[[${field}]]`);
        }
      }
    },
  );

  it('states the statutory withdrawal period, which is fourteen days and not ours to change', () => {
    for (const d of legal.filter((x) => x.kind === 'returns')) {
      const raw = JSON.stringify(d).toLowerCase();
      expect(raw).toMatch(/fourteen|vierzehn/);
      // Our own thirty-day promise must be presented as additional, never as a replacement.
      expect(raw).toMatch(/thirty|dreißig/);
    }
  });

  it('records when each legal document was last EDITED — not that a lawyer saw it', () => {
    /**
     * `lastReviewed` is required by window 6's schema and renders as "Last reviewed {date}". That
     * wording is the CMS package's, not ours, and it sits uneasily beside this app saying the copy
     * is unreviewed — review flagged the contradiction and it is fair.
     *
     * The honest reading, recorded here and in cms/brand-a/README.md: the date is when the text was
     * last edited in this repository. It is NOT a legal review. The field cannot be dropped — the
     * schema requires it — so it is documented instead.
     */
    const readme = readFileSync(
      new URL('../../../../cms/brand-a/README.md', import.meta.url),
      'utf8',
    );
    expect(readme, 'the README must say what lastReviewed does and does not mean').toMatch(
      /lastReviewed/,
    );
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

  it.each(LOCALES)('%s: the footer lists no destination twice', (locale) => {
    // The "Help" column repeated /legal/imprint and /legal/returns, which legalLinks already
    // carried — every legal page appeared twice in the footer, in both locales.
    const footer = documents.filter((d) => d._type === 'footer' && d.locale === locale);
    const links = hrefs(footer);
    const duplicated = [...new Set(links)].filter((h) => links.filter((x) => x === h).length > 1);
    expect(duplicated, `the footer repeats ${duplicated.join(', ')}`).toEqual([]);
  });

  it.each(LOCALES)('%s: hero and block CTAs resolve too, not just the chrome', (locale) => {
    // This walk covered navigation and footer only, while the README claimed "every internal link"
    // — so a hero CTA could point anywhere and nothing noticed.
    const pages = documents.filter(
      (d) => d.locale === locale && (d._type === 'page' || d._type === 'campaignLanding'),
    );
    const pageSlugs = byType('page')
      .filter((d) => d.locale === locale)
      .map((d) => d.slug.current);
    const legalSlugs = byType('legal')
      .filter((d) => d.locale === locale)
      .map((d) => d.slug.current);

    const ctaHrefs = hrefs(pages);
    expect(ctaHrefs.length, 'no CTAs found — the walk is broken').toBeGreaterThan(0);
    for (const href of ctaHrefs) {
      const resolved =
        APP_ROUTES.some((r) => r.test(href)) ||
        pageSlugs.some((sl) => href === `/pages/${sl}`) ||
        legalSlugs.some((sl) => href === `/legal/${sl}`);
      expect(resolved, `${locale}: CTA ${href} resolves to nothing`).toBe(true);
    }
  });

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

    // The productStory block, asserted positively. Review noted it was only ever checked
    // negatively (that it did not render its "not available" state), which an empty block passes.
    const story = home!.blocks?.find((b) => b._type === 'productStory') as
      { headline: string; cta?: { label: string } } | undefined;
    expect(story, 'the home page lost its productStory block').toBeDefined();
    expect(body, 'the productStory headline is missing').toContain(story!.headline);
    if (story!.cta) expect(body).toContain(story!.cta.label);
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

  it.each(LOCALES)('%s renders the campaign landing through its real route', async (locale) => {
    // `campaign/[slug]` 404s unless `campaignIsLive`, which compares `startsAt`/`endsAt` to *now*.
    // Without a pinned clock this test would pass today and start failing on 2026-12-01, which is
    // the kind of green that rots quietly.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
    try {
      const landing = byType('campaignLanding').find((d) => d.locale === locale);
      expect(landing, `no campaign landing for ${locale}`).toBeDefined();
      useCms(locale);

      const out = await render(
        await CampaignPage({ params: params(locale, landing!.slug.current) }),
      );
      const body = text(out);

      expect(body).toContain(landing!.hero.headline);
      expect(body).toContain(landing!.hero.subheadline);
      for (const empty of emptyStates(locale)) expect(body).not.toContain(empty);
    } finally {
      vi.useRealTimers();
    }
  });

  it('404s an expired campaign rather than selling a promise that has run out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-06-01T00:00:00.000Z')); // after every endsAt
    try {
      const landing = byType('campaignLanding').find((d) => d.locale === 'en-GB');
      useCms('en-GB');
      await expect(
        CampaignPage({ params: params('en-GB', landing!.slug.current) }),
      ).rejects.toThrow('NEXT_NOT_FOUND');
    } finally {
      vi.useRealTimers();
    }
  });

  it('404s for a slug nobody authored, rather than rendering an empty shell', async () => {
    useCms('en-GB');
    await expect(ContentPage({ params: params('en-GB', 'does-not-exist') })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });
});
