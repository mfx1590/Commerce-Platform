import { schemaTypes, validateDocument } from '@platform/cms';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ASPECTS,
  cloudNameFrom,
  resolveMedia,
} from '../../../../cms/brand-a/scripts/resolve-media.mjs';

/**
 * Brand A's imagery: `cms/brand-a/media/manifest.json` (the 19 premium stills and the 2 hero loops;
 * binaries live outside the repo and are served from Cloudinary) and the seed-time resolver that turns
 * the content's media slots into delivery URLs. See cms/brand-a/README.md.
 */

interface Slot {
  slot: string;
  kind: 'image' | 'video';
  publicId: string;
  source: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  aspect?: string;
  poster?: string;
  alt?: Record<string, string>;
}

const MANIFEST_URL = new URL('../../../../cms/brand-a/media/manifest.json', import.meta.url);
const CONTENT_DIR = new URL('../../../../cms/brand-a/content/', import.meta.url);

const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8')) as { slots: Slot[] };
const authored = readdirSync(CONTENT_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap((f) => JSON.parse(readFileSync(new URL(f, CONTENT_DIR), 'utf8')) as object[]);

/** Every `mediaSlot` the content references. */
function referencedSlots(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => referencedSlots(v, found));
  else if (value !== null && typeof value === 'object') {
    const slot = (value as { mediaSlot?: unknown }).mediaSlot;
    if (typeof slot === 'string') found.add(slot);
    Object.values(value).forEach((v) => referencedSlots(v, found));
  }
  return found;
}

const page = (blocks: object[], hero?: object, seo?: object) => ({
  _id: 'page.en-GB.test',
  _type: 'page',
  locale: 'en-GB',
  title: 'Test',
  slug: { _type: 'slug', current: 'test' },
  hero: { _type: 'hero', headline: 'Test', ...(hero === undefined ? {} : { image: hero }) },
  blocks,
  ...(seo === undefined ? {} : { seo }),
});
const ref = (slot: string, extra: object = {}) => ({ _type: 'image', mediaSlot: slot, ...extra });
/** A hero loop reference, as authored: the resolver turns it into a `/video/upload/` URL (#386). */
const loop = (slot: string) => ({ _type: 'heroVideo', mediaSlot: slot });
/** A page whose hero pairs a still with a loop — the only shape a video is valid in. */
const heroWithLoop = (image: object | undefined, video: object, extra: object = {}) => ({
  ...page([]),
  hero: {
    _type: 'hero',
    headline: 'Test',
    ...(image === undefined ? {} : { image }),
    video,
    ...extra,
  },
});

interface HeroShape {
  _type: 'hero';
  image?: unknown;
  video?: { _type: string; cloudinaryUrl?: string; mediaSlot?: string };
}

/** Every hero in a set of documents, authored or resolved. */
function heroesIn(documents: unknown[]): HeroShape[] {
  const found: HeroShape[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') {
      if ((value as { _type?: unknown })._type === 'hero') found.push(value as HeroShape);
      Object.values(value).forEach(visit);
    }
  };
  documents.forEach(visit);
  return found;
}

describe('the media manifest', () => {
  it('holds exactly the 19 premium stills and the 2 hero loops — nothing else', () => {
    const images = manifest.slots.filter((s) => s.kind === 'image');
    const videos = manifest.slots.filter((s) => s.kind === 'video');
    expect(images).toHaveLength(19);
    expect(images.every((s) => s.source.startsWith('premium-4k/'))).toBe(true);
    expect(videos.map((s) => s.slot).sort()).toEqual([
      'campaign-autumn-hero-loop-8s',
      'home-hero-shirt-loop-8s',
    ]);
  });

  it('records each file by size and sha256, and its public id under brand-a/', () => {
    for (const s of manifest.slots) {
      expect(s.sha256, s.slot).toMatch(/^[0-9a-f]{64}$/);
      expect(s.bytes, s.slot).toBeGreaterThan(0);
      expect(s.publicId).toBe(`brand-a/${s.slot}`);
    }
    expect(new Set(manifest.slots.map((s) => s.slot)).size).toBe(manifest.slots.length);
  });

  it("states each still's aspect, and the stated aspect is the real one", () => {
    const ratio: Record<string, number> = { '3:2': 1.5, '3:4': 0.75, '16:9': 16 / 9 };
    for (const s of manifest.slots.filter((x) => x.kind === 'image')) {
      expect(ratio[s.aspect!], `${s.slot} has an unknown aspect`).toBeDefined();
      expect(Math.abs(s.width! / s.height! - ratio[s.aspect!]!) / ratio[s.aspect!]!).toBeLessThan(
        0.01,
      );
    }
  });

  it('gives every loop a still as its poster', () => {
    const stills = new Set(manifest.slots.filter((s) => s.kind === 'image').map((s) => s.slot));
    for (const v of manifest.slots.filter((s) => s.kind === 'video')) {
      expect(stills.has(v.poster!), `${v.slot} poster ${v.poster}`).toBe(true);
    }
  });
});

describe('the authored content and the manifest agree', () => {
  it('references only slots the manifest has, each still with alt text in both locales', () => {
    const referenced = referencedSlots(authored);
    expect(referenced.size).toBeGreaterThan(0);
    const bySlot = new Map(manifest.slots.map((s) => [s.slot, s]));
    let stills = 0;
    for (const slot of referenced) {
      expect(bySlot.has(slot), `${slot} is not in the manifest`).toBe(true);
      // A loop carries no alt text and must not: it is `aria-hidden`, and the poster's alt is what
      // the hero says to a screen reader (#386, DESIGN.md §7). Requiring one here would invite
      // someone to write alt text a screen reader never reaches.
      if (bySlot.get(slot)!.kind === 'video') {
        expect(bySlot.get(slot)!.alt, `${slot} is a loop and needs no alt`).toBeUndefined();
        continue;
      }
      stills += 1;
      for (const locale of ['en-GB', 'de-DE']) {
        expect(bySlot.get(slot)!.alt?.[locale], `${slot} ${locale} alt`).toBeTruthy();
      }
    }
    expect(stills, 'the content still places stills, not only loops').toBeGreaterThan(0);
  });

  it('resolves with a placeholder cloud name, leaves no slot behind, and passes the CMS validation', async () => {
    const { documents, errors, dropped, resolved } = resolveMedia(authored, manifest, {
      cloudName: 'placeholder-cloud',
    });
    expect(errors).toEqual([]);
    expect(dropped).toBe(0);
    // 18 stills + the 4 hero loops (two documents x two locales) since #386.
    expect(resolved).toBe(22);
    expect(JSON.stringify(documents)).not.toContain('mediaSlot');
    expect(JSON.stringify(documents)).toContain(
      'https://res.cloudinary.com/placeholder-cloud/image/upload/brand-a/home-hero-01',
    );
    for (const doc of documents as { _id: string }[]) {
      expect(await validateDocument(doc, schemaTypes), doc._id).toEqual([]);
    }
  });

  it('places both hero loops over their posters, as Cloudinary video URLs', async () => {
    const { documents, errors } = resolveMedia(authored, manifest, {
      cloudName: 'placeholder-cloud',
    });
    expect(errors).toEqual([]);

    const heroes = heroesIn(documents);
    // Two documents carry a loop (home and campaign), in both locales.
    const withVideo = heroes.filter((hero) => hero.video !== undefined);
    expect(withVideo).toHaveLength(4);

    for (const hero of withVideo) {
      expect(hero.video).toEqual({
        _type: 'heroVideo',
        cloudinaryUrl: expect.stringMatching(
          /^https:\/\/res\.cloudinary\.com\/placeholder-cloud\/video\/upload\/brand-a\//,
        ),
      });
      // The poster is what makes the loop valid — never a loop on its own.
      expect(hero.image, 'a loop always has its poster beside it').toBeDefined();
    }

    expect(withVideo.map((hero) => hero.video?.cloudinaryUrl).sort()).toEqual([
      'https://res.cloudinary.com/placeholder-cloud/video/upload/brand-a/campaign-autumn-hero-loop-8s',
      'https://res.cloudinary.com/placeholder-cloud/video/upload/brand-a/campaign-autumn-hero-loop-8s',
      'https://res.cloudinary.com/placeholder-cloud/video/upload/brand-a/home-hero-shirt-loop-8s',
      'https://res.cloudinary.com/placeholder-cloud/video/upload/brand-a/home-hero-shirt-loop-8s',
    ]);

    for (const doc of documents as { _id: string }[]) {
      expect(await validateDocument(doc, schemaTypes), doc._id).toEqual([]);
    }
  });

  it('shows no still twice on the home page, so the hero and the block below stay distinct', () => {
    // This is the other half of the #386 swap, and the half a test has to hold.
    //
    // The hero had to move to `home-hero-02` because that is its loop's poster, and `home-hero-02`
    // was already on the `imageBlock` below — so the two stills were swapped. The poster pairing is
    // covered by the test below, but nothing stopped someone reverting only the imageBlock half:
    // the hero would still match its loop, every other test would pass, and the page would quietly
    // print one still twice. Hence this.
    const homes = (authored as { _id: string }[]).filter((doc) => doc._id.endsWith('.home'));
    expect(homes, 'both locales of the home page').toHaveLength(2);

    for (const doc of homes) {
      const slots: string[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value !== null && typeof value === 'object') {
          const record = value as { _type?: unknown; mediaSlot?: unknown };
          if (record._type === 'image' && typeof record.mediaSlot === 'string') {
            slots.push(record.mediaSlot);
          }
          Object.values(value).forEach(visit);
        }
      };
      visit(doc);

      expect(slots.length, `${doc._id} places some stills`).toBeGreaterThan(1);
      const twice = slots.filter((slot, i) => slots.indexOf(slot) !== i);
      expect(twice, `${doc._id} shows a still more than once: ${twice.join(', ')}`).toEqual([]);
    }
  });

  it('each placed loop plays over the still the manifest names as its poster', () => {
    const byLoop = new Map(
      manifest.slots
        .filter((slot) => slot.kind === 'video')
        .map((slot) => [slot.slot, slot.poster]),
    );
    expect(byLoop.size).toBe(2);

    for (const hero of heroesIn(authored)) {
      const slot = (hero.video as { mediaSlot?: string } | undefined)?.mediaSlot;
      if (slot === undefined) continue;
      expect(byLoop.has(slot), `${slot} is a video slot`).toBe(true);
      // Read from the authored content, so this fails if either side is edited alone.
      expect((hero.image as { mediaSlot?: string } | undefined)?.mediaSlot).toBe(byLoop.get(slot));
    }
  });

  it('without a cloud name, leaves both loops out and the heroes stay valid', async () => {
    const { documents, errors } = resolveMedia(authored, manifest, {});
    expect(errors).toEqual([]);
    expect(JSON.stringify(documents)).not.toContain('heroVideo');
    expect(JSON.stringify(documents)).not.toContain('/video/upload/');
    for (const doc of documents as { _id: string }[]) {
      expect(await validateDocument(doc, schemaTypes), doc._id).toEqual([]);
    }
  });

  it('without a cloud name, leaves the optional images out and still passes the CMS validation', async () => {
    const { documents, errors, dropped } = resolveMedia(authored, manifest, {});
    expect(errors).toEqual([]);
    expect(dropped).toBe(22);
    expect(JSON.stringify(documents)).not.toContain('mediaSlot');
    expect(JSON.stringify(documents)).not.toContain('imageBlock');
    for (const doc of documents as { _id: string }[]) {
      expect(await validateDocument(doc, schemaTypes), doc._id).toEqual([]);
    }
  });
});

describe('the resolver refuses what it cannot place', () => {
  it('fails a slot missing from the manifest, with or without a cloud name', () => {
    for (const options of [{ cloudName: 'c' }, {}]) {
      const { errors } = resolveMedia([page([], ref('no-such-slot'))], manifest, options);
      expect(errors.join('\n')).toMatch(/"no-such-slot" is not in media\/manifest\.json/);
    }
  });

  it('fails a still placed where its proportions do not fit', () => {
    expect(ALLOWED_ASPECTS.hero).toEqual(['3:2']);
    const portraitHero = resolveMedia([page([], ref('campaign-autumn-03'))], manifest, {
      cloudName: 'c',
    });
    expect(portraitHero.errors.join('\n')).toMatch(/is 3:4; a hero takes 3:2/);

    const wrongOg = resolveMedia(
      [page([], undefined, { ogImage: ref('home-hero-01') })],
      manifest,
      {
        cloudName: 'c',
      },
    );
    expect(wrongOg.errors.join('\n')).toMatch(/is 3:2; a ogImage takes 16:9/);
  });

  it('fails a loop placed as an image', () => {
    const { errors } = resolveMedia([page([], ref('home-hero-shirt-loop-8s'))], manifest, {
      cloudName: 'c',
    });
    expect(errors.join('\n')).toMatch(/is a video, not an image/);
  });

  it('fails an image placed as a loop — the mirror of placing a loop as an image', () => {
    const { errors } = resolveMedia(
      [heroWithLoop(ref('home-hero-02'), loop('home-hero-01'))],
      manifest,
      { cloudName: 'c' },
    );
    expect(errors.join('\n')).toMatch(/"home-hero-01" is a image, not a video/);
  });

  it('fails a loop whose hero shows a still that is not its poster', () => {
    const { errors } = resolveMedia(
      [heroWithLoop(ref('home-hero-01'), loop('home-hero-shirt-loop-8s'))],
      manifest,
      { cloudName: 'c' },
    );
    expect(errors.join('\n')).toMatch(
      /"home-hero-shirt-loop-8s" plays over "home-hero-02", but the hero image is "home-hero-01"/,
    );
  });

  it('fails a loop on a hero with no still at all', () => {
    const { errors } = resolveMedia(
      [heroWithLoop(undefined, loop('home-hero-shirt-loop-8s'))],
      manifest,
      { cloudName: 'c' },
    );
    expect(errors.join('\n')).toMatch(/the hero image is "missing"/);
  });

  it('fails a loop placed anywhere but a hero', () => {
    const doc = page([{ _type: 'imageBlock', _key: 'a', video: loop('home-hero-shirt-loop-8s') }]);
    const { errors } = resolveMedia([doc], manifest, { cloudName: 'c' });
    expect(errors.join('\n')).toMatch(/a video goes on a hero only/);
  });

  it('refuses a mis-paired loop even with no cloud name set', () => {
    // The pairing is an authoring mistake, not a deployment one: it must not hide wherever
    // Cloudinary happens to be unconfigured.
    const { errors } = resolveMedia(
      [heroWithLoop(ref('home-hero-01'), loop('home-hero-shirt-loop-8s'))],
      manifest,
      {},
    );
    expect(errors.join('\n')).toMatch(/plays over "home-hero-02"/);
  });

  it('fails a referenced slot that has no alt text for the locale', () => {
    // campaign-spring-hero is in the manifest but not placed, so it carries no alt text yet.
    const { errors } = resolveMedia([page([], ref('campaign-spring-hero'))], manifest, {
      cloudName: 'c',
    });
    expect(errors.join('\n')).toMatch(/has no en-GB alt text/);
  });

  it('makes a REQUIRED image without a cloud name an error, never a silent skip', () => {
    const required = page([], undefined, { ogImage: ref('og-default', { mediaRequired: true }) });
    const { errors, dropped } = resolveMedia([required], manifest, {});
    expect(dropped).toBe(0);
    expect(errors.join('\n')).toMatch(/"og-default" is required, and no cloud name is set/);
  });

  it('removes an image block as a whole when its image is left out', () => {
    const doc = page([
      { _type: 'imageBlock', _key: 'a', image: ref('about-loom-hands') },
      { _type: 'richText', _key: 'b', content: [] },
    ]);
    const { documents } = resolveMedia([doc], manifest, {});
    expect((documents[0] as { blocks: { _type: string }[] }).blocks.map((b) => b._type)).toEqual([
      'richText',
    ]);
  });
});

describe('the cloud name, and only the cloud name', () => {
  it('prefers the brand-specific variable, then the shared one, else nothing', () => {
    expect(cloudNameFrom({ CLOUDINARY_CLOUD_NAME_BRAND_A: 'a', CLOUDINARY_CLOUD_NAME: 'b' })).toBe(
      'a',
    );
    expect(cloudNameFrom({ CLOUDINARY_CLOUD_NAME: 'b' })).toBe('b');
    expect(cloudNameFrom({ CLOUDINARY_CLOUD_NAME_BRAND_A: '  ', CLOUDINARY_CLOUD_NAME: '' })).toBe(
      undefined,
    );
  });

  it('accepts a valid cloud name and refuses anything that is not one, loudly', () => {
    expect(cloudNameFrom({ CLOUDINARY_CLOUD_NAME: ' fieldnote-eu_1 ' })).toBe('fieldnote-eu_1');
    for (const bad of ['Fieldnote', 'a/b', 'a.b', '../x', 'a b', 'x?y=1']) {
      expect(() => cloudNameFrom({ CLOUDINARY_CLOUD_NAME_BRAND_A: bad }), bad).toThrow(
        /is not valid/,
      );
    }
  });

  it('never reads the API key or secret', () => {
    const read: string[] = [];
    const env = new Proxy(
      {
        CLOUDINARY_CLOUD_NAME: 'b',
        CLOUDINARY_API_KEY: 'key',
        CLOUDINARY_API_SECRET: 'secret',
      } as Record<string, string>,
      {
        get(target, key: string) {
          read.push(key);
          return target[key];
        },
      },
    );
    cloudNameFrom(env);
    expect(read.filter((k) => /KEY|SECRET/.test(k))).toEqual([]);
  });
});
