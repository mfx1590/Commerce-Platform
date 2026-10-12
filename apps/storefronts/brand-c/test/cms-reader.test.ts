import { footerFixture, navigationFixture, pageFixture } from '@platform/cms';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CmsConfig } from '@/lib/cms/config';
import { createReader, resetCmsWarnings } from '@/lib/cms/reader';

const CONFIGURED: CmsConfig = {
  projectId: 'abc123',
  apiVersion: '2025-02-19',
  readToken: 'sk',
  previewSecret: 'p',
  webhookSecret: 'w',
};
const UNCONFIGURED: CmsConfig = { ...CONFIGURED, projectId: null, readToken: null };

function fetchAnswering(answer: (url: URL) => { status?: number; body: unknown }): {
  impl: typeof fetch;
  calls: { url: URL; init: RequestInit & { next?: unknown } }[];
} {
  const calls: { url: URL; init: RequestInit & { next?: unknown } }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init: init ?? {} });
    const { status = 200, body } = answer(parsed);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-sanity-request-id': 'req-9' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('createReader', () => {
  beforeEach(() => resetCmsWarnings());

  it('without credentials returns empty content and warns exactly once', async () => {
    const warn = vi.fn();
    const reader = createReader({ config: UNCONFIGURED, storeCode: 'brand-a', warn });

    expect(reader.dataset).toBeNull();
    expect(await reader.page('en-GB', 'about')).toBeNull();
    expect(await reader.navigation('en-GB')).toBeNull();
    expect(await reader.footer('en-GB')).toBeNull();
    expect(await reader.pageSlugs('en-GB')).toEqual([]);
    // a second reader in the same process does not warn again
    createReader({ config: UNCONFIGURED, storeCode: 'brand-a', warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/SANITY_PROJECT_ID is not set/);
  });

  it('without a store, or with a store that has no dataset, does the same', async () => {
    const warn = vi.fn();
    expect(
      await createReader({ config: CONFIGURED, storeCode: null, warn }).page('en-GB', 'a'),
    ).toBeNull();
    resetCmsWarnings();
    const reader = createReader({ config: CONFIGURED, storeCode: 'brand-z', warn });
    expect(await reader.legalSlugs('en-GB')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toMatch(/no dataset for store "brand-z"/);
  });

  it('reads published documents from the store’s dataset with the three tag levels', async () => {
    const { impl, calls } = fetchAnswering(() => ({ body: { result: pageFixture } }));
    const warn = vi.fn();
    const reader = createReader({
      config: CONFIGURED,
      storeCode: 'brand-a',
      fetchImpl: impl,
      warn,
    });

    expect(reader.dataset).toBe('brand-a');
    expect(reader.preview).toBe(false);
    expect(await reader.page('en-GB', 'about')).toEqual(pageFixture);
    expect(calls[0]?.url.pathname).toBe('/v2025-02-19/data/query/brand-a');
    expect(calls[0]?.url.searchParams.get('$locale')).toBe('"en-GB"');
    expect(calls[0]?.url.searchParams.get('$slug')).toBe('"about"');
    expect(calls[0]?.init.next).toEqual({
      tags: ['cms', 'cms:page', 'cms:page:en-GB:about'],
      revalidate: 300,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('tags navigation by key and footer as default', async () => {
    const { impl, calls } = fetchAnswering((url) => ({
      body: { result: url.searchParams.get('$key') ? navigationFixture : footerFixture },
    }));
    const reader = createReader({ config: CONFIGURED, storeCode: 'brand-a', fetchImpl: impl });

    expect(await reader.navigation('en-GB')).toEqual(navigationFixture);
    expect(await reader.footer('de-DE')).toEqual(footerFixture);
    expect(calls[0]?.url.searchParams.get('$key')).toBe('"main"');
    expect((calls[0]?.init.next as { tags: string[] }).tags).toContain('cms:navigation:en-GB:main');
    expect((calls[1]?.init.next as { tags: string[] }).tags).toContain('cms:footer:de-DE:default');
  });

  it('serves drafts only when preview is requested AND a read token exists', () => {
    const { impl } = fetchAnswering(() => ({ body: { result: null } }));
    expect(
      createReader({ config: CONFIGURED, storeCode: 'brand-a', preview: true, fetchImpl: impl })
        .preview,
    ).toBe(true);
    expect(
      createReader({
        config: { ...CONFIGURED, readToken: null },
        storeCode: 'brand-a',
        preview: true,
        fetchImpl: impl,
      }).preview,
    ).toBe(false);
  });

  it('turns a failed request into empty content plus one warning with the request id', async () => {
    const { impl } = fetchAnswering(() => ({ status: 500, body: { error: 'boom' } }));
    const warn = vi.fn();
    const reader = createReader({
      config: CONFIGURED,
      storeCode: 'brand-a',
      fetchImpl: impl,
      warn,
    });

    expect(await reader.page('en-GB', 'about')).toBeNull();
    expect(await reader.pageSlugs('en-GB')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toBe('[cms] brand-a published read failed (500 request req-9)');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk');
  });
});
