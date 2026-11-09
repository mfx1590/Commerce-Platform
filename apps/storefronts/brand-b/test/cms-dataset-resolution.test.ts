import { pageFixture } from '@platform/cms';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CmsConfig } from '@/lib/cms/config';
import { PREVIEW_COOKIE, signPreviewToken, verifyPreviewToken } from '@/lib/cms/preview';
import { createReader, resetCmsWarnings } from '@/lib/cms/reader';

/**
 * #521 — which Sanity dataset a storefront reads, and what happens when there is none.
 *
 * A: an unknown store code (a brand onboarded from the admin UI, not in `BRAND_DATASETS`) never
 *    turns into an error on a route: the reader is empty with one warning, the preview route
 *    answers 503 and sets no cookie, the routed-documents list (the sitemap's source) is `[]`.
 * B: the store row's `content_space_id` — the dataset by contract — is used when it is a valid
 *    dataset name, an invalid one falls back to the seeded list, absence falls back too, and the
 *    name never comes from anything but the store row.
 */

const CONFIG: CmsConfig = {
  projectId: 'abc123',
  apiVersion: '2025-02-19',
  readToken: 'sk',
  previewSecret: 'preview-secret',
  webhookSecret: null,
};

function fetchRecording(result: unknown = pageFixture) {
  const urls: URL[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    urls.push(new URL(String(url)));
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

/** The dataset segment of a Sanity query URL: `/v<ver>/data/query/<dataset>`. */
const datasetOf = (url: URL) => url.pathname.split('/data/query/')[1] ?? null;

describe('B: the dataset comes from the store row — content_space_id first, then the seeded list', () => {
  beforeEach(() => resetCmsWarnings());

  it('a UI-onboarded store (unknown code) reads its content_space_id dataset', async () => {
    const { impl, urls } = fetchRecording();
    const warn = vi.fn();
    const reader = createReader({
      config: CONFIG,
      storeCode: 'north-outfitters',
      contentSpaceId: 'north-outfitters',
      fetchImpl: impl,
      warn,
    });
    expect(reader.dataset).toBe('north-outfitters');
    expect(await reader.page('en-GB', 'about')).toEqual(pageFixture);
    expect(datasetOf(urls[0]!)).toBe('north-outfitters');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a seeded store with content_space_id set reads that dataset (they are equal by contract)', async () => {
    const { impl, urls } = fetchRecording();
    const reader = createReader({
      config: CONFIG,
      storeCode: 'brand-a',
      contentSpaceId: 'brand-a',
      fetchImpl: impl,
      warn: vi.fn(),
    });
    await reader.navigation('en-GB');
    expect(datasetOf(urls[0]!)).toBe('brand-a');
  });

  it('an invalid content_space_id falls back to the seeded list by store code', async () => {
    for (const invalid of ['Brand A', '../production', 'brand a', 'a'.repeat(65), '']) {
      const { impl, urls } = fetchRecording();
      const warn = vi.fn();
      const reader = createReader({
        config: CONFIG,
        storeCode: 'brand-a',
        contentSpaceId: invalid,
        fetchImpl: impl,
        warn,
      });
      expect(reader.dataset, invalid).toBe('brand-a');
      await reader.footer('en-GB');
      expect(datasetOf(urls[0]!), invalid).toBe('brand-a');
      expect(warn).not.toHaveBeenCalled();
      resetCmsWarnings();
    }
  });

  it('an absent content_space_id falls back to the seeded list by store code', () => {
    const warn = vi.fn();
    expect(createReader({ config: CONFIG, storeCode: 'brand-b', warn }).dataset).toBe('brand-b');
    expect(
      createReader({ config: CONFIG, storeCode: 'brand-c', contentSpaceId: null, warn }).dataset,
    ).toBe('brand-c');
    expect(warn).not.toHaveBeenCalled();
  });

  it('an invalid content_space_id on an unknown store means no content, with one warning', async () => {
    const warn = vi.fn();
    const reader = createReader({
      config: CONFIG,
      storeCode: 'north-outfitters',
      contentSpaceId: 'North Outfitters',
      warn,
    });
    expect(reader.dataset).toBeNull();
    expect(await reader.page('en-GB', 'about')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/no dataset for store "north-outfitters"/);
  });
});

describe('A: an unknown store code never becomes an error on a route', () => {
  beforeEach(() => resetCmsWarnings());

  it('the reader is empty and warns once, and the routed list (sitemap source) is []', async () => {
    const { impl } = fetchRecording();
    const warn = vi.fn();
    const reader = createReader({
      config: CONFIG,
      storeCode: 'north-outfitters',
      fetchImpl: impl,
      warn,
    });
    expect(reader.dataset).toBeNull();
    expect(reader.preview).toBe(false);
    expect(await reader.page('en-GB', 'about')).toBeNull();
    expect(await reader.navigation('en-GB')).toBeNull();
    expect(await reader.footer('en-GB')).toBeNull();
    expect(await reader.pageSlugs('en-GB')).toEqual([]);
    expect(await reader.routedDocuments('en-GB')).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/rendering without CMS content/);
  });
});

/**
 * The Next bindings, with `GET /store` and the cookie jar faked: `getCms()` and the preview route
 * handler as mounted. `resetModules` so each store answer gets a fresh `cache()`.
 */
describe('A + B through the mounted bindings (getCms, /api/cms/preview)', () => {
  const ENV_KEYS = ['SANITY_PROJECT_ID', 'SANITY_READ_TOKEN', 'SANITY_PREVIEW_SECRET', 'SITE_URL'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.SANITY_PROJECT_ID = CONFIG.projectId!;
    process.env.SANITY_READ_TOKEN = CONFIG.readToken!;
    process.env.SANITY_PREVIEW_SECRET = CONFIG.previewSecret!;
    process.env.SITE_URL = 'http://localhost:3100';
    vi.resetModules();
    resetCmsWarnings();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.doUnmock('@/lib/store');
    vi.doUnmock('next/headers');
  });

  type FakeStore = { code: string; content_space_id?: string | null } | null;

  async function bindings(store: FakeStore, cookie?: string) {
    vi.doMock('@/lib/store', () => ({
      getStoreOrNull: vi.fn(async () => store),
      getStore: vi.fn(async () => store),
    }));
    vi.doMock('next/headers', () => ({
      cookies: vi.fn(async () => ({
        get: (name: string) => (name === PREVIEW_COOKIE && cookie ? { value: cookie } : undefined),
      })),
    }));
    const { getCms } = await import('@/lib/cms');
    const { GET } = await import('@/app/api/cms/preview/route');
    return { getCms, GET };
  }

  const previewRequest = (query = '') =>
    new Request(`http://localhost:3100/api/cms/preview?secret=preview-secret${query}`);

  it('unknown store: getCms() is the empty reader; the preview route answers 503 with no cookie', async () => {
    const { getCms, GET } = await bindings({ code: 'north-outfitters' });
    const cms = await getCms();
    expect(cms.dataset).toBeNull();
    expect(await cms.page('en-GB', 'about')).toBeNull();

    const response = await GET(previewRequest('&redirect=/en-GB/pages/about'));
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('no store at all (GET /store failed): the same, never a throw', async () => {
    const { getCms, GET } = await bindings(null);
    expect((await getCms()).dataset).toBeNull();
    const response = await GET(previewRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('UI-onboarded store: getCms() reads its content_space_id; the preview cookie is signed for it', async () => {
    const { getCms, GET } = await bindings({
      code: 'north-outfitters',
      content_space_id: 'north-outfitters',
    });
    expect((await getCms()).dataset).toBe('north-outfitters');

    const response = await GET(previewRequest('&redirect=/en-GB/pages/about'));
    expect(response.status).toBe(307);
    const cookie = response.headers.get('set-cookie') ?? '';
    const token = cookie.split(';')[0]?.split('=').slice(1).join('=') ?? '';
    expect(verifyPreviewToken('preview-secret', 'north-outfitters', token)).toBe(true);
    expect(verifyPreviewToken('preview-secret', 'brand-a', token)).toBe(false);
  });

  it('a valid preview cookie for the content_space_id dataset turns preview on in getCms()', async () => {
    const token = signPreviewToken('preview-secret', 'north-outfitters', Date.now() + 60_000);
    const { getCms } = await bindings(
      { code: 'north-outfitters', content_space_id: 'north-outfitters' },
      token,
    );
    expect((await getCms()).preview).toBe(true);
  });

  it('the dataset never comes from the request: a ?dataset= query is ignored by the preview route', async () => {
    const { GET } = await bindings({ code: 'brand-a', content_space_id: null });
    const response = await GET(previewRequest('&dataset=production&redirect=/en-GB'));
    expect(response.status).toBe(307);
    const token =
      (response.headers.get('set-cookie') ?? '').split(';')[0]?.split('=').slice(1).join('=') ?? '';
    expect(verifyPreviewToken('preview-secret', 'brand-a', token)).toBe(true);
    expect(verifyPreviewToken('preview-secret', 'production', token)).toBe(false);
  });

  it('an invalid content_space_id on a seeded store falls back to its seeded dataset', async () => {
    const { getCms } = await bindings({ code: 'brand-b', content_space_id: 'Brand B!' });
    expect((await getCms()).dataset).toBe('brand-b');
  });
});
