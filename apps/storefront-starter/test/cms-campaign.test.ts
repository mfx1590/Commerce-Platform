import { campaignLandingFixture } from '@platform/cms';
import type { EmbedBlock } from '@platform/cms';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAll, render, text } from './cms-render';
import CampaignPage, {
  generateMetadata as campaignMetadata,
} from '@/app/[locale]/(content)/campaign/[slug]/page';
import { Embed, PROVIDER_SANDBOX, SRCDOC_SANDBOX, SafeLink } from '@/lib/cms/components';
import type * as ContentModule from '@/lib/cms/content';
import { createContentContext, getContent } from '@/lib/cms/content';
import type { CmsReader } from '@/lib/cms/reader';
import { safeHref } from '@/lib/cms/safe-href';
import { campaignIsLive } from '@/lib/cms/schedule';

vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));
vi.mock('@/lib/catalog', () => ({ getProduct: vi.fn().mockResolvedValue(null) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/cms/content', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentModule>()),
  getContent: vi.fn(),
}));

const IMAGES = { projectId: 'abc', dataset: 'brand-a' };
/** Inside the fixture's startsAt (2026-03-01) … endsAt (2026-04-30) window. */
const DURING = Date.parse('2026-04-01T12:00:00.000Z');

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

function useCms(cms: CmsReader) {
  vi.mocked(getContent).mockResolvedValue({
    cms,
    ctx: createContentContext({ locale: 'en-GB', images: IMAGES }),
  });
}

const params = Promise.resolve({ locale: 'en-GB', slug: 'spring-sale' });

beforeEach(() => vi.useRealTimers());

describe('campaignIsLive', () => {
  const landing = campaignLandingFixture;
  it('is live between startsAt and endsAt, 404 outside, fail-closed on garbage', () => {
    expect(campaignIsLive(landing, DURING)).toBe(true);
    expect(campaignIsLive(landing, Date.parse('2026-02-01T00:00:00Z'))).toBe(false);
    expect(campaignIsLive(landing, Date.parse('2026-05-01T00:00:00Z'))).toBe(false);
    expect(campaignIsLive({}, DURING)).toBe(true);
    expect(campaignIsLive({ startsAt: 'garbage' }, DURING)).toBe(false);
    expect(campaignIsLive({ endsAt: 'garbage' }, DURING)).toBe(false);
  });
});

describe('/campaign/[slug]', () => {
  it('renders hero, blocks and the sandboxed embed during the campaign', async () => {
    vi.useFakeTimers({ now: DURING });
    useCms(reader({ campaignLanding: async () => campaignLandingFixture }));
    const tree = await render(await CampaignPage({ params }));

    expect(text(findAll(tree, 'h1'))).toBe('Up to 30% off last season');
    expect(findAll(tree, 'article')[0]?.props['data-campaign-id']).toBe('spring-2026');
    const frames = findAll(tree, 'iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.props).toMatchObject({
      src: 'https://spring-sale.framer.website/',
      sandbox: PROVIDER_SANDBOX,
      title: 'Spring lookbook',
      height: 900,
      loading: 'lazy',
      referrerPolicy: 'strict-origin-when-cross-origin',
      allow: '',
    });
    // no third-party script outside the frame
    expect(findAll(tree, 'script')).toEqual([]);
  });

  it('404s outside the campaign window and when unpublished', async () => {
    useCms(reader({ campaignLanding: async () => campaignLandingFixture }));
    vi.useFakeTimers({ now: Date.parse('2026-05-02T00:00:00Z') });
    await expect(CampaignPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await campaignMetadata({ params })).toEqual({ title: 'Page not found' });

    vi.useRealTimers();
    useCms(reader());
    await expect(CampaignPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('keeps noIndex metadata during the campaign', async () => {
    vi.useFakeTimers({ now: DURING });
    useCms(reader({ campaignLanding: async () => campaignLandingFixture }));
    const metadata = await campaignMetadata({ params });
    expect(metadata.title).toBe('Spring sale — Brand A');
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates?.canonical).toBe('/en-GB/campaign/spring-sale');
  });
});

describe('Embed sandboxing', () => {
  const base: EmbedBlock = { _type: 'embed', provider: 'html', title: 'Promo', html: '<p>Hi</p>' };

  it('srcdoc snippets run without allow-same-origin', async () => {
    const tree = await render(Embed({ block: base }));
    const frame = findAll(tree, 'iframe')[0]!;
    expect(frame.props['sandbox']).toBe(SRCDOC_SANDBOX);
    expect(frame.props['sandbox']).not.toContain('allow-same-origin');
    expect(frame.props['srcDoc']).toBe('<p>Hi</p>');
    expect(frame.props['src']).toBeUndefined();
  });

  it('provider frames keep allow-same-origin but only on allow-listed https hosts', async () => {
    const framerBlock = (url?: string): EmbedBlock => ({
      _type: 'embed',
      provider: 'framer',
      title: 'Promo',
      ...(url === undefined ? {} : { url }),
    });
    const framer = await render(Embed({ block: framerBlock('https://x.framer.app/') }));
    expect(findAll(framer, 'iframe')[0]?.props['sandbox']).toBe(PROVIDER_SANDBOX);

    for (const url of ['https://evil.example/', 'http://x.framer.app/', undefined]) {
      expect(await render(Embed({ block: framerBlock(url) })), String(url)).toEqual([]);
    }
  });

  it('clamps the height and renders nothing for an empty snippet', async () => {
    const tall = await render(Embed({ block: { ...base, height: 9999 } }));
    expect(findAll(tall, 'iframe')[0]?.props['height']).toBe(4000);
    expect(await render(Embed({ block: { ...base, html: '   ' } }))).toEqual([]);
  });
});

describe('safeHref (the renderer does not trust stored hrefs)', () => {
  it('classifies internal, external and unsafe', () => {
    expect(safeHref('/en-GB/products')).toEqual({ kind: 'internal', href: '/en-GB/products' });
    expect(safeHref('https://instagram.com/x')).toEqual({
      kind: 'external',
      href: 'https://instagram.com/x',
    });
    for (const bad of [
      'javascript:alert(1)',
      '//evil.example',
      'http://x.example',
      '/\\evil',
      '',
      undefined,
    ]) {
      expect(safeHref(bad).kind, String(bad)).toBe('unsafe');
    }
  });

  it('SafeLink renders an unsafe stored href as plain text', async () => {
    const unsafe = await render(SafeLink({ href: 'javascript:alert(1)', children: 'Click' }));
    expect(findAll(unsafe, 'span')[0]).toBeDefined();
    expect(text(unsafe)).toBe('Click');
    expect(findAll(unsafe, 'a')).toEqual([]);

    const external = await render(
      SafeLink({ href: 'https://x.example', children: 'Out', openInNewTab: true }),
    );
    expect(findAll(external, 'a')[0]?.props).toMatchObject({
      rel: 'noopener noreferrer',
      target: '_blank',
    });
  });
});

describe('UTM passthrough on /campaign/*', () => {
  it('the middleware writes the attribution cookie for a campaign URL', async () => {
    const { default: middleware } = await import('@/middleware');
    const request = new NextRequest(
      'http://localhost:3100/en-GB/campaign/spring-sale?utm_campaign=spring&utm_source=newsletter',
      { headers: { referer: 'https://news.example.com/issue-9?email=x@y.z' } },
    );
    const response = middleware(request);
    const cookie = response.cookies.get('sf_attribution');
    expect(cookie).toBeDefined();
    const attribution = JSON.parse(cookie!.value) as {
      first: Record<string, unknown>;
      last: Record<string, unknown>;
    };
    expect(attribution.first).toMatchObject({
      utm_campaign: 'spring',
      utm_source: 'newsletter',
      landing_path: '/en-GB/campaign/spring-sale',
      referrer: 'https://news.example.com',
    });
    expect(attribution.last).toMatchObject({ utm_campaign: 'spring' });
    expect(cookie!.httpOnly).toBe(true);
  });
});
