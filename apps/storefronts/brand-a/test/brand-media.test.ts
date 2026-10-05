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
  it('references only slots the manifest has, each with alt text in both locales', () => {
    const referenced = referencedSlots(authored);
    expect(referenced.size).toBeGreaterThan(0);
    const bySlot = new Map(manifest.slots.map((s) => [s.slot, s]));
    for (const slot of referenced) {
      expect(bySlot.has(slot), `${slot} is not in the manifest`).toBe(true);
      for (const locale of ['en-GB', 'de-DE']) {
        expect(bySlot.get(slot)!.alt?.[locale], `${slot} ${locale} alt`).toBeTruthy();
      }
    }
  });

  it('resolves with a placeholder cloud name, leaves no slot behind, and passes the CMS validation', async () => {
    const { documents, errors, dropped, resolved } = resolveMedia(authored, manifest, {
      cloudName: 'placeholder-cloud',
    });
    expect(errors).toEqual([]);
    expect(dropped).toBe(0);
    expect(resolved).toBe(18);
    expect(JSON.stringify(documents)).not.toContain('mediaSlot');
    expect(JSON.stringify(documents)).toContain(
      'https://res.cloudinary.com/placeholder-cloud/image/upload/brand-a/home-hero-01',
    );
    for (const doc of documents as { _id: string }[]) {
      expect(await validateDocument(doc, schemaTypes), doc._id).toEqual([]);
    }
  });

  it('without a cloud name, leaves the optional images out and still passes the CMS validation', async () => {
    const { documents, errors, dropped } = resolveMedia(authored, manifest, {});
    expect(errors).toEqual([]);
    expect(dropped).toBe(18);
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
