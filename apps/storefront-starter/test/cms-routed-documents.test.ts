import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutedDocument } from '@/lib/cms';
import type { CmsConfig } from '@/lib/cms/config';
import { createReader, resetCmsWarnings } from '@/lib/cms/reader';
import { campaignIsLive } from '@/lib/cms/schedule';

/**
 * `routedDocuments` filters in its query and on the rows, so a canned response would test nothing: these tests
 * answer the reader's request by running its real GROQ against a dataset, with the evaluator the
 * Studio ships (`groq-js`, reached through `@platform/cms` → `sanity`; the storefront does not
 * depend on it). If it cannot be resolved the suite fails — it never skips.
 */
interface Groq {
  parse(query: string, options?: { params?: Record<string, unknown> }): unknown;
  evaluate(
    tree: unknown,
    options: { dataset: unknown[]; params: Record<string, unknown> },
  ): Promise<{ get(): Promise<unknown> }>;
}

function loadGroq(): Groq {
  const here = createRequire(import.meta.url);
  const studio = createRequire(here.resolve('@platform/cms')).resolve('sanity');
  return createRequire(studio)('groq-js') as Groq;
}

const groq = loadGroq();

const CONFIGURED: CmsConfig = {
  projectId: 'project',
  apiVersion: '2025-02-19',
  readToken: 'token',
  previewSecret: 'preview',
  webhookSecret: 'webhook',
};
const UNCONFIGURED: CmsConfig = { ...CONFIGURED, projectId: null, readToken: null };

type Stored = Record<string, unknown>;

function stored(
  type: string,
  slug: string | null,
  extra: Stored = {},
  locale: string = 'en-GB',
): Stored {
  return {
    _id: `${type}.${locale}.${slug ?? 'unslugged'}`,
    _type: type,
    _updatedAt: '2026-09-01T00:00:00Z',
    locale,
    ...(slug === null ? {} : { slug: { _type: 'slug', current: slug } }),
    ...extra,
  };
}

/** A Sanity that holds `dataset` and answers every query by evaluating it. */
function sanityHolding(dataset: Stored[]): {
  impl: typeof fetch;
  calls: { url: URL; init: RequestInit & { next?: unknown } }[];
  /** What Sanity answered, before the reader touched it. */
  answers: unknown[];
} {
  const calls: { url: URL; init: RequestInit & { next?: unknown } }[] = [];
  const answers: unknown[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init: init ?? {} });
    const params: Record<string, unknown> = {};
    for (const [name, value] of parsed.searchParams) {
      if (name.startsWith('$')) params[name.slice(1)] = JSON.parse(value);
    }
    const tree = groq.parse(parsed.searchParams.get('query') ?? '', { params });
    const result = await (await groq.evaluate(tree, { dataset, params })).get();
    answers.push(result);
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls, answers };
}

async function routed(dataset: Stored[], locale = 'en-GB'): Promise<RoutedDocument[]> {
  const { impl } = sanityHolding(dataset);
  const warn = vi.fn();
  const documents = await createReader({
    config: CONFIGURED,
    storeCode: 'brand-a',
    fetchImpl: impl,
    warn,
  }).routedDocuments(locale);
  expect(warn).not.toHaveBeenCalled();
  return documents;
}

const byTypeAndSlug = (a: RoutedDocument, b: RoutedDocument) =>
  `${a.type}/${a.slug}`.localeCompare(`${b.type}/${b.slug}`);

describe('routedDocuments', () => {
  beforeEach(() => resetCmsWarnings());

  it('lists the pages, legal documents and campaign landings of the locale, and nothing else', async () => {
    const documents = await routed([
      stored('page', 'about'),
      stored('legal', 'privacy'),
      stored('campaignLanding', 'spring-sale'),
      stored('navigation', 'main'),
      stored('footer', 'default'),
      stored('page', 'ueber-uns', {}, 'de-DE'),
    ]);

    expect(documents.sort(byTypeAndSlug)).toEqual([
      { type: 'campaignLanding', slug: 'spring-sale' },
      { type: 'legal', slug: 'privacy' },
      { type: 'page', slug: 'about' },
    ]);
  });

  it('filter: a document marked seo.noIndex is not returned, whatever its type', async () => {
    const documents = await routed([
      stored('page', 'about'),
      stored('page', 'thank-you', { seo: { noIndex: true } }),
      stored('legal', 'retired-terms', { seo: { noIndex: true } }),
      stored('campaignLanding', 'private-sale', { seo: { title: 'Private', noIndex: true } }),
    ]);

    expect(documents).toEqual([{ type: 'page', slug: 'about' }]);
  });

  it('filter: the home page is not returned, but only the page — another type may use the slug', async () => {
    const documents = await routed([
      stored('page', 'home'),
      stored('page', 'about'),
      stored('legal', 'home'),
    ]);

    expect(documents.sort(byTypeAndSlug)).toEqual([
      { type: 'legal', slug: 'home' },
      { type: 'page', slug: 'about' },
    ]);
  });

  it('filter: a document without a slug is not returned — not even by Sanity', async () => {
    const { impl, answers } = sanityHolding([
      stored('page', null),
      stored('legal', null, { slug: { _type: 'slug' } }),
      stored('page', 'about'),
    ]);
    const reader = createReader({ config: CONFIGURED, storeCode: 'brand-a', fetchImpl: impl });

    expect(await reader.routedDocuments('en-GB')).toEqual([{ type: 'page', slug: 'about' }]);
    // filtered at the source: the reader's own tidying never saw the two unslugged documents
    expect(answers).toEqual([
      [{ type: 'page', slug: 'about', noIndex: false, startsAt: null, endsAt: null }],
    ]);
  });

  it('a document with no seo object at all is still returned, like one that leaves noIndex unset or false', async () => {
    const documents = await routed([
      stored('page', 'no-seo-object'),
      stored('page', 'seo-without-flag', { seo: { title: 'Titled' } }),
      stored('page', 'flag-false', { seo: { noIndex: false } }),
    ]);

    expect(documents.map((d) => d.slug).sort()).toEqual([
      'flag-false',
      'no-seo-object',
      'seo-without-flag',
    ]);
  });

  it('returns a campaign schedule untouched and does not apply it', async () => {
    const ended = { startsAt: '2026-03-01T00:00:00.000Z', endsAt: '2026-04-30T23:59:59.000Z' };
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    const documents = (
      await routed([
        stored('campaignLanding', 'ended', ended),
        stored('campaignLanding', 'upcoming', { startsAt: '2027-01-01T00:00:00.000Z' }),
        stored('campaignLanding', 'evergreen'),
      ])
    ).sort(byTypeAndSlug);

    expect(documents).toEqual([
      { type: 'campaignLanding', slug: 'ended', ...ended },
      { type: 'campaignLanding', slug: 'evergreen' },
      { type: 'campaignLanding', slug: 'upcoming', startsAt: '2027-01-01T00:00:00.000Z' },
    ]);
    // "Live now" is the caller's decision at request time: the list still carries all three.
    expect(documents.map((d) => campaignIsLive(d, now))).toEqual([false, true, false]);
  });

  it('an unbounded side is absent, never null — campaignIsLive fails closed on anything it cannot parse', async () => {
    const [evergreen, page] = (
      await routed([stored('campaignLanding', 'evergreen'), stored('page', 'about')])
    ).sort(byTypeAndSlug);

    expect(evergreen).not.toHaveProperty('startsAt');
    expect(evergreen).not.toHaveProperty('endsAt');
    expect(page).not.toHaveProperty('startsAt');
    expect(page).not.toHaveProperty('endsAt');
  });

  // Two documents on one (type, locale, slug) should not exist (the Studio refuses them), but the
  // routes are defined for it: the by-slug read renders the newest. The list must describe that
  // document — its noIndex, its schedule — never an older one standing in for it.
  const OLDER = { _id: 'older', _updatedAt: '2026-08-01T00:00:00Z' };
  const NEWER = { _id: 'newer', _updatedAt: '2026-09-15T00:00:00Z' };

  it('collision: an older indexable document never stands in for a newer noIndex one', async () => {
    const documents = await routed([
      stored('page', 'about', { ...OLDER }),
      stored('page', 'about', { ...NEWER, seo: { noIndex: true } }),
      stored('campaignLanding', 'spring-sale', { ...OLDER, endsAt: '2026-12-31T00:00:00.000Z' }),
      stored('campaignLanding', 'spring-sale', { ...NEWER, seo: { noIndex: true } }),
    ]);

    expect(documents).toEqual([]);
  });

  it('collision: a newer indexable document is listed although an older one was noIndex', async () => {
    const documents = await routed([
      stored('legal', 'terms', { ...OLDER, seo: { noIndex: true } }),
      stored('legal', 'terms', { ...NEWER }),
    ]);

    expect(documents).toEqual([{ type: 'legal', slug: 'terms' }]);
  });

  it('collision: two campaigns with different schedules — the newer one’s dates, once', async () => {
    const documents = await routed([
      stored('campaignLanding', 'spring-sale', {
        ...OLDER,
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-08-31T00:00:00.000Z',
      }),
      stored('campaignLanding', 'spring-sale', { ...NEWER, endsAt: '2026-12-31T00:00:00.000Z' }),
    ]);

    expect(documents).toEqual([
      { type: 'campaignLanding', slug: 'spring-sale', endsAt: '2026-12-31T00:00:00.000Z' },
    ]);
  });

  it('reads published content with the locale as a parameter and the four cache tags', async () => {
    const { impl, calls } = sanityHolding([stored('page', 'about')]);
    const reader = createReader({ config: CONFIGURED, storeCode: 'brand-a', fetchImpl: impl });

    await reader.routedDocuments('de-DE');

    expect(reader.preview).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.hostname).toBe('project.apicdn.sanity.io');
    expect(calls[0]?.url.searchParams.get('perspective')).toBe('published');
    expect(calls[0]?.url.searchParams.get('$locale')).toBe('"de-DE"');
    expect(calls[0]?.url.searchParams.get('query')).not.toContain('de-DE');
    expect(new Headers(calls[0]?.init.headers).has('authorization')).toBe(false);
    expect(calls[0]?.init.next).toEqual({
      tags: ['cms', 'cms:page', 'cms:legal', 'cms:campaignLanding'],
      revalidate: 300,
    });
  });

  it('a failed read is [] plus the usual single warning', async () => {
    const impl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'x-sanity-request-id': 'request-nine' },
        }),
    ) as unknown as typeof fetch;
    const warn = vi.fn();
    const reader = createReader({
      config: CONFIGURED,
      storeCode: 'brand-a',
      fetchImpl: impl,
      warn,
    });

    expect(await reader.routedDocuments('en-GB')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[cms] brand-a published read failed (500 request request-nine)',
    );
  });

  it('a network failure and a malformed answer are [] too — it never throws', async () => {
    const warn = vi.fn();
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const garbage = vi.fn(
      async () => new Response(JSON.stringify({ result: { not: 'a list' } }), { status: 200 }),
    ) as unknown as typeof fetch;

    expect(
      await createReader({
        config: CONFIGURED,
        storeCode: 'brand-a',
        fetchImpl: offline,
        warn,
      }).routedDocuments('en-GB'),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(
      await createReader({
        config: CONFIGURED,
        storeCode: 'brand-a',
        fetchImpl: garbage,
        warn,
      }).routedDocuments('en-GB'),
    ).toEqual([]);
  });

  it('the empty reader — CMS unconfigured, store unknown, store without a dataset — returns []', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(
      await createReader({
        config: UNCONFIGURED,
        storeCode: 'brand-a',
        fetchImpl,
        warn,
      }).routedDocuments('en-GB'),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    resetCmsWarnings();
    expect(
      await createReader({ config: CONFIGURED, storeCode: null, fetchImpl, warn }).routedDocuments(
        'en-GB',
      ),
    ).toEqual([]);
    resetCmsWarnings();
    expect(
      await createReader({
        config: CONFIGURED,
        storeCode: 'brand-z',
        fetchImpl,
        warn,
      }).routedDocuments('en-GB'),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * The sitemap is cached; reading a cookie would make it dynamic and could list a draft. So nothing
 * a self-built reader loads may reach `next/headers` — checked on the import graph itself.
 */
describe('the routedDocuments path and next/headers', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url));
  const CMS = path.join(SRC, 'lib', 'cms');

  function resolveModule(from: string, specifier: string): string | null {
    const base = specifier.startsWith('@/')
      ? path.join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? path.resolve(path.dirname(from), specifier)
        : null;
    if (base === null) return null;
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
    ];
    const found = candidates.find((file) => existsSync(file) && statSync(file).isFile());
    if (!found) throw new Error(`cannot resolve "${specifier}" from ${from}`);
    return found;
  }

  /** Every module reachable from `entry`: files inside the app, and the packages they name. */
  function importGraph(entry: string): { files: string[]; packages: string[] } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue = [entry];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (files.has(file)) continue;
      files.add(file);
      const source = readFileSync(file, 'utf8');
      // static `import … from '…'`, `export … from '…'`, bare `import '…'` and dynamic `import('…')`
      for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        const resolved = resolveModule(file, specifier);
        if (resolved === null) packages.add(specifier);
        else queue.push(resolved);
      }
    }
    return {
      files: [...files].map((file) => path.relative(CMS, file).replaceAll('\\', '/')).sort(),
      packages: [...packages].sort(),
    };
  }

  it('createReader and campaignIsLive load no next/headers — no Next module at all', () => {
    const reader = importGraph(path.join(CMS, 'reader.ts'));
    const schedule = importGraph(path.join(CMS, 'schedule.ts'));

    expect(reader.files).toEqual(['client.ts', 'config.ts', 'queries.ts', 'reader.ts', 'tags.ts']);
    expect(reader.packages).toEqual(['@platform/cms']);
    expect(schedule.files).toEqual(['schedule.ts']);
    expect(schedule.packages).toEqual([]);
  });

  it('the same walk does find next/headers where it is imported (getCms, in the index)', () => {
    expect(importGraph(path.join(CMS, 'index.ts')).packages).toContain('next/headers');
  });

  it('the Studio package the reader imports brings no Next either', () => {
    const entry = createRequire(import.meta.url).resolve('@platform/cms');
    const dist = path.dirname(entry);
    const pending = [entry];
    const seen = new Set<string>();
    const named = new Set<string>();
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(
        /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('.')) pending.push(path.resolve(path.dirname(file), specifier));
        else named.add(specifier);
      }
    }

    expect(seen.size).toBeGreaterThan(1);
    expect([...seen].every((file) => file.startsWith(dist))).toBe(true);
    expect([...named].filter((specifier) => /^next(\/|$)/.test(specifier))).toEqual([]);
  });
});

describe('the cms index', () => {
  it('exports campaignIsLive (and the RoutedDocument type, checked by the compiler above)', async () => {
    vi.doMock('next/headers', () => ({ cookies: vi.fn() }));
    vi.doMock('@/lib/store', () => ({ getStoreOrNull: vi.fn() }));
    const index = await import('@/lib/cms');

    expect(index.campaignIsLive).toBe(campaignIsLive);
    expect(index.createReader).toBe(createReader);
  });
});
