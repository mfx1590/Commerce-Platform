import { describe, expect, it, vi } from 'vitest';
import { CmsClient, CmsError, defineQuery, queryUrl } from '@/lib/cms/client';
import { cmsConfigFromEnv, isCmsConfigured } from '@/lib/cms/config';

const BASE = { projectId: 'abc123', dataset: 'brand-a', apiVersion: '2025-02-19' };
const QUERY = defineQuery<{ title: string } | null>(
  '*[_type == "page" && slug.current == $slug][0]',
);

/** A `fetch` stand-in that records the call and answers with `body`. */
function stubFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const calls: { url: string; init: RequestInit & { next?: unknown } }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('cmsConfigFromEnv', () => {
  it('reads every SANITY_* variable, blank means unset, and pins the API version', () => {
    expect(cmsConfigFromEnv({})).toEqual({
      projectId: null,
      apiVersion: '2025-02-19',
      readToken: null,
      previewSecret: null,
      webhookSecret: null,
    });
    const config = cmsConfigFromEnv({
      SANITY_PROJECT_ID: ' abc123 ',
      SANITY_API_VERSION: '',
      SANITY_READ_TOKEN: 'sk',
      SANITY_PREVIEW_SECRET: 'p',
      SANITY_WEBHOOK_SECRET: 'w',
    });
    expect(config).toEqual({
      projectId: 'abc123',
      apiVersion: '2025-02-19',
      readToken: 'sk',
      previewSecret: 'p',
      webhookSecret: 'w',
    });
    expect(isCmsConfigured(config)).toBe(true);
    expect(isCmsConfigured(cmsConfigFromEnv({}))).toBe(false);
  });
});

describe('queryUrl', () => {
  it('uses the CDN and the published perspective by default, params as $name=json', () => {
    const url = new URL(queryUrl(BASE, QUERY.groq, { slug: 'about', locale: 'en-GB', n: 2 }));
    expect(url.origin).toBe('https://abc123.apicdn.sanity.io');
    expect(url.pathname).toBe('/v2025-02-19/data/query/brand-a');
    expect(url.searchParams.get('query')).toBe(QUERY.groq);
    expect(url.searchParams.get('$slug')).toBe('"about"');
    expect(url.searchParams.get('$locale')).toBe('"en-GB"');
    expect(url.searchParams.get('$n')).toBe('2');
    expect(url.searchParams.get('perspective')).toBe('published');
  });

  it('uses the live API and the drafts perspective in preview', () => {
    const url = new URL(queryUrl({ ...BASE, preview: true }, QUERY.groq));
    expect(url.origin).toBe('https://abc123.api.sanity.io');
    expect(url.searchParams.get('perspective')).toBe('drafts');
  });
});

describe('CmsClient', () => {
  it('published: no token, cached with tags and revalidate', async () => {
    const { impl, calls } = stubFetch({ result: { title: 'About' } });
    const client = new CmsClient({ ...BASE, readToken: 'sk', fetchImpl: impl });
    const result = await client.fetch(QUERY, { slug: 'about' }, { tags: ['cms'], revalidate: 300 });

    expect(result).toEqual({ title: 'About' });
    expect(client.preview).toBe(false);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBeNull();
    expect(calls[0]?.init.next).toEqual({ tags: ['cms'], revalidate: 300 });
    expect(calls[0]?.init.cache).toBeUndefined();
  });

  it('preview: bearer token, no-store, and never cached with tags', async () => {
    const { impl, calls } = stubFetch({ result: { title: 'Draft' } });
    const client = new CmsClient({ ...BASE, readToken: 'sk', preview: true, fetchImpl: impl });
    await client.fetch(QUERY, { slug: 'about' }, { tags: ['cms'], revalidate: 300 });

    expect(client.preview).toBe(true);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer sk');
    expect(calls[0]?.init.cache).toBe('no-store');
    expect(calls[0]?.init.next).toBeUndefined();
    expect(calls[0]?.url).toContain('perspective=drafts');
  });

  it('refuses preview without a read token', () => {
    expect(() => new CmsClient({ ...BASE, preview: true })).toThrow(/SANITY_READ_TOKEN/);
  });

  it('maps a missing result to null and failures to CmsError with the request id', async () => {
    const empty = stubFetch({ result: null });
    expect(
      await new CmsClient({ ...BASE, fetchImpl: empty.impl }).fetch(QUERY, { slug: 'x' }),
    ).toBeNull();

    const failing = stubFetch(
      { error: 'boom' },
      { status: 500, headers: { 'x-sanity-request-id': 'req-1' } },
    );
    const error = await new CmsClient({ ...BASE, fetchImpl: failing.impl })
      .fetch(QUERY, { slug: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CmsError);
    expect((error as CmsError).status).toBe(500);
    expect((error as CmsError).requestId).toBe('req-1');

    const garbage = stubFetch('not json');
    await expect(
      new CmsClient({ ...BASE, fetchImpl: garbage.impl }).fetch(QUERY, { slug: 'x' }),
    ).rejects.toThrow(/invalid JSON/);
  });
});
