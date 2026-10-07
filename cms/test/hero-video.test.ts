import { describe, expect, it } from 'vitest';
import {
  CLOUDINARY_URL_PATTERN,
  CLOUDINARY_VIDEO_URL_PATTERN,
  campaignLandingFixture,
  heroPoster,
  pageFixture,
  schemaTypes,
  validateDocument,
} from '../src/index.js';
import type { CampaignLandingDocument, Hero, PageDocument } from '../src/index.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const VIDEO = 'https://res.cloudinary.com/brand-alpha/video/upload/cms/spring-shelf-loop.mp4';
const IMAGE = 'https://res.cloudinary.com/brand-alpha/image/upload/cms/spring-shelf.jpg';

const validate = (doc: PageDocument | CampaignLandingDocument) =>
  validateDocument(doc as unknown as Record<string, unknown>, schemaTypes);

describe('CLOUDINARY_VIDEO_URL_PATTERN', () => {
  it('accepts only Cloudinary video delivery URLs', () => {
    expect(CLOUDINARY_VIDEO_URL_PATTERN.test(VIDEO)).toBe(true);
    expect(
      CLOUDINARY_VIDEO_URL_PATTERN.test('https://res.cloudinary.com/demo/video/upload/x'),
    ).toBe(true);
    for (const value of [
      IMAGE,
      'https://res.cloudinary.com/demo/raw/upload/clip.mp4',
      'https://res.cloudinary.com/demo/video/fetch/http://x/y.mp4',
      'http://res.cloudinary.com/demo/video/upload/clip.mp4',
      'https://videos.example.com/clip.mp4',
      'not a url',
      '',
    ]) {
      expect(CLOUDINARY_VIDEO_URL_PATTERN.test(value), value).toBe(false);
    }
  });

  it('is a subset of CLOUDINARY_URL_PATTERN (every hero video is a Cloudinary URL)', () => {
    for (const value of [VIDEO, IMAGE, 'https://res.cloudinary.com/demo/raw/upload/a']) {
      if (CLOUDINARY_VIDEO_URL_PATTERN.test(value))
        expect(CLOUDINARY_URL_PATTERN.test(value)).toBe(true);
    }
  });
});

describe('heroPoster', () => {
  it('passes an absent hero, a hero without video, and a hero with both', async () => {
    expect(await heroPoster(undefined, {})).toBe(true);
    expect(await heroPoster({ headline: 'x' }, {})).toBe(true);
    expect(
      await heroPoster({ headline: 'x', image: { alt: 'a' }, video: { cloudinaryUrl: VIDEO } }, {}),
    ).toBe(true);
  });

  it('refuses a video without an image', async () => {
    expect(await heroPoster({ headline: 'x', video: { cloudinaryUrl: VIDEO } }, {})).toMatch(
      /Add an image/,
    );
  });
});

describe('hero.video', () => {
  it('the campaign fixture carries a video next to its image and stays valid', async () => {
    expect(campaignLandingFixture.hero.video?.cloudinaryUrl).toBe(VIDEO);
    expect(campaignLandingFixture.hero.image).toBeDefined();
    expect(await validate(campaignLandingFixture)).toEqual([]);
  });

  it('existing content without the field is valid unchanged', async () => {
    expect(pageFixture.hero?.video).toBeUndefined();
    expect(await validate(pageFixture)).toEqual([]);
  });

  it('a hero with video and no image fails at the hero', async () => {
    const doc = clone(campaignLandingFixture);
    delete doc.hero.image;
    const errors = await validate(doc);
    expect(errors.map((e) => e.path)).toEqual(['hero']);
    expect(errors[0]?.message).toMatch(/Add an image/);
  });

  it('a block hero with video and no image fails at that block', async () => {
    const doc = clone(pageFixture);
    const hero: Hero = {
      _type: 'hero',
      _key: 'loop',
      headline: 'Loop',
      video: { _type: 'heroVideo', cloudinaryUrl: VIDEO },
    };
    doc.blocks = [hero];
    expect(await validate(doc)).toEqual([
      { path: 'blocks[0]', message: expect.stringMatching(/Add an image/) as string },
    ]);
  });

  it('rejects an image URL, a non-Cloudinary URL and an empty URL on the video', async () => {
    for (const bad of [IMAGE, 'https://videos.example.com/clip.mp4', '']) {
      const doc = clone(campaignLandingFixture);
      doc.hero.video = { _type: 'heroVideo', cloudinaryUrl: bad };
      const errors = await validate(doc);
      // an empty string fails `required` and the pattern: every error sits on the URL field
      expect(errors.length, bad).toBeGreaterThan(0);
      expect(new Set(errors.map((e) => e.path)), bad).toEqual(
        new Set(['hero.video.cloudinaryUrl']),
      );
    }
  });

  it('a video object without a URL is required-failed, not silently accepted', async () => {
    const doc = clone(campaignLandingFixture);
    (doc.hero.video as Partial<Hero['video']>) = { _type: 'heroVideo' };
    const errors = await validate(doc);
    expect(errors).toEqual([{ path: 'hero.video.cloudinaryUrl', message: 'Required' }]);
  });
});
