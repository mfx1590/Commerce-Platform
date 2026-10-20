import type { CampaignLandingDocument, Hero, HeroVideo, PageDocument } from '@platform/cms';
import { CLOUDINARY_VIDEO_URL_PATTERN, campaignLandingFixture, pageFixture } from '@platform/cms';
import { isCloudinaryUrl } from '@platform/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CmsConfig } from '@/lib/cms/config';
import { heroVideo, normalizeHeroVideo } from '@/lib/cms/hero-video';
import { createReader, resetCmsWarnings } from '@/lib/cms/reader';

/**
 * #330, the CMS half: what `cms.page()` / `cms.campaignLanding()` expose as `hero.video`, and the
 * invariant the renderer (window 3) may rely on — `video` present ⇒ `image` present and the URL is
 * a Cloudinary video delivery URL. Everything else about the loop (reduced motion, the pause
 * control, poster-first loading) is rendering and is not here.
 */

const VIDEO = 'https://res.cloudinary.com/brand-alpha/video/upload/cms/spring-shelf-loop.mp4';
const IMAGE = 'https://res.cloudinary.com/brand-alpha/image/upload/cms/spring-shelf.jpg';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const CONFIG: CmsConfig = {
  projectId: 'abc123',
  apiVersion: '2025-02-19',
  readToken: null,
  previewSecret: null,
  webhookSecret: null,
};

function readerAnswering(result: unknown) {
  const impl = vi.fn(
    async () =>
      new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
  return createReader({ config: CONFIG, storeCode: 'brand-a', fetchImpl: impl, warn: vi.fn() });
}

const withVideo = (hero: Hero, cloudinaryUrl = VIDEO): Hero => ({
  ...hero,
  video: { _type: 'heroVideo', cloudinaryUrl },
});

describe('heroVideo', () => {
  it('returns the video when the hero has an image and a Cloudinary video URL', () => {
    const hero = withVideo(clone(campaignLandingFixture.hero));
    expect(heroVideo(hero)).toEqual({ _type: 'heroVideo', cloudinaryUrl: VIDEO });
  });

  it('returns null without an image: the poster is not optional', () => {
    const hero = withVideo(clone(campaignLandingFixture.hero));
    delete hero.image;
    expect(heroVideo(hero)).toBeNull();
  });

  it('returns null for anything that is not a Cloudinary video delivery URL', () => {
    const hero = clone(campaignLandingFixture.hero);
    for (const bad of [
      IMAGE,
      'https://res.cloudinary.com/demo/raw/upload/clip.mp4',
      'https://videos.example.com/clip.mp4',
      'http://res.cloudinary.com/demo/video/upload/clip.mp4',
      'javascript:alert(1)',
      '',
    ]) {
      expect(heroVideo(withVideo(hero, bad)), bad).toBeNull();
    }
    expect(heroVideo({ ...hero, video: 'nope' as unknown as HeroVideo })).toBeNull();
    expect(heroVideo({ ...hero, video: { _type: 'heroVideo' } as HeroVideo })).toBeNull();
  });

  it('returns null when there is no video at all', () => {
    expect(heroVideo(pageFixture.hero!)).toBeNull();
    expect(heroVideo({ headline: 'x' } as Hero)).toBeNull();
  });

  it('accepts only URLs the shared Cloudinary loader also recognises', () => {
    for (const value of [VIDEO, IMAGE, 'https://videos.example.com/clip.mp4']) {
      if (CLOUDINARY_VIDEO_URL_PATTERN.test(value)) expect(isCloudinaryUrl(value)).toBe(true);
    }
  });
});

describe('normalizeHeroVideo', () => {
  it('keeps a valid video and returns the same object when nothing changes', () => {
    const doc = clone(campaignLandingFixture);
    expect(normalizeHeroVideo(doc)).toBe(doc);
    expect(normalizeHeroVideo(doc).hero.video?.cloudinaryUrl).toBe(VIDEO);
    expect(normalizeHeroVideo(null)).toBeNull();
  });

  it('strips an invalid top-level video without touching anything else', () => {
    const doc = clone(campaignLandingFixture);
    delete doc.hero.image;
    const out = normalizeHeroVideo(doc);
    expect(out).not.toBe(doc);
    expect(out.hero.video).toBeUndefined();
    expect(out.hero.headline).toBe(doc.hero.headline);
    expect(out.blocks).toBe(doc.blocks);
    // the input is not mutated
    expect(doc.hero.video?.cloudinaryUrl).toBe(VIDEO);
  });

  it('applies the same policy to heroes among the blocks', () => {
    const doc = clone(pageFixture);
    const ok = withVideo({
      _type: 'hero',
      _key: 'a',
      headline: 'A',
      image: pageFixture.hero!.image!,
    });
    const noImage = withVideo({ _type: 'hero', _key: 'b', headline: 'B' });
    const badUrl = withVideo({ ...ok, _key: 'c' }, IMAGE);
    doc.blocks = [ok, noImage, badUrl, ...(doc.blocks ?? [])];
    const out = normalizeHeroVideo(doc);
    const heroes = (out.blocks ?? []).filter((b): b is Hero => b._type === 'hero');
    expect(heroes.map((h) => [h._key, h.video?.cloudinaryUrl])).toEqual([
      ['a', VIDEO],
      ['b', undefined],
      ['c', undefined],
    ]);
    expect(out.blocks?.length).toBe(doc.blocks.length);
  });
});

describe('the reader exposes hero.video under the policy', () => {
  beforeEach(() => resetCmsWarnings());

  it('page(): a hero with image + video comes through unchanged', async () => {
    const doc: PageDocument = clone(pageFixture);
    doc.hero = withVideo(doc.hero!);
    const page = await readerAnswering(doc).page('en-GB', 'about');
    expect(page?.hero?.video).toEqual({ _type: 'heroVideo', cloudinaryUrl: VIDEO });
    expect(page?.hero?.image).toBeDefined();
  });

  it('page(): a stored hero whose video has no poster is exposed without the video', async () => {
    const doc: PageDocument = clone(pageFixture);
    doc.hero = withVideo(doc.hero!);
    delete doc.hero.image;
    const page = await readerAnswering(doc).page('en-GB', 'about');
    expect(page?.hero?.video).toBeUndefined();
    expect(page?.hero?.headline).toBe(pageFixture.hero?.headline);
  });

  it('campaignLanding(): the fixture video survives; a stored image URL on it does not', async () => {
    const live = await readerAnswering(campaignLandingFixture).campaignLanding('en-GB', 'spring');
    expect(live?.hero.video?.cloudinaryUrl).toBe(VIDEO);

    const doc: CampaignLandingDocument = clone(campaignLandingFixture);
    doc.hero = withVideo(doc.hero, IMAGE);
    const tampered = await readerAnswering(doc).campaignLanding('en-GB', 'spring');
    expect(tampered?.hero.video).toBeUndefined();
    expect(tampered?.hero.image?.cloudinaryUrl).toBe(IMAGE);
  });

  it('content without the field is unchanged: no video key appears', async () => {
    const page = await readerAnswering(pageFixture).page('en-GB', 'about');
    expect(page).toEqual(pageFixture);
    expect(page?.hero && 'video' in page.hero).toBe(false);
  });
});
