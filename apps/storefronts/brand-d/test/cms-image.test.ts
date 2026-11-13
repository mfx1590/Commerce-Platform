import type { SanityImage as SanityImageValue } from '@platform/cms';
import { CLOUDINARY_URL_PATTERN, schemaTypes, validateDocument, pageFixture } from '@platform/cms';
import { isCloudinaryUrl } from '@platform/ui';
import { describe, expect, it } from 'vitest';
import { findAll, render } from './cms-render';
import { IMAGE_WIDTHS, SanityImage } from '@/lib/cms/components/sanity-image';
import { createContentContext } from '@/lib/cms/content';
import { documentMetadata } from '@/lib/cms/metadata';

const ctx = createContentContext({
  locale: 'en-GB',
  images: { projectId: 'abc', dataset: 'brand-a' },
});
const DELIVERY = 'https://res.cloudinary.com/brand-alpha/image/upload/cms/spring-shelf.jpg';

const cloudinaryImage: SanityImageValue = {
  _type: 'image',
  cloudinaryUrl: DELIVERY,
  alt: 'Folded jackets on a shelf',
};

const sanityImage: SanityImageValue = {
  _type: 'image',
  asset: { _type: 'reference', _ref: 'image-shelf-1200x800-jpg' },
  alt: 'Folded jackets on a shelf',
};

async function renderImg(image: SanityImageValue) {
  return findAll(await render(SanityImage({ image, ctx })), 'img')[0];
}

describe('Cloudinary images go through the shared @platform/ui loader', () => {
  it('builds src and a srcset over the width steps', async () => {
    const img = (await renderImg(cloudinaryImage))!;
    expect(img.props['src']).toBe(
      'https://res.cloudinary.com/brand-alpha/image/upload/c_limit,w_1200,q_auto,f_auto/cms/spring-shelf.jpg',
    );
    const srcSet = String(img.props['srcSet']);
    for (const width of IMAGE_WIDTHS) {
      expect(srcSet).toContain(`c_limit,w_${width},q_auto,f_auto`);
      expect(srcSet).toContain(` ${width}w`);
    }
    expect(img.props['alt']).toBe('Folded jackets on a shelf');
    expect(img.props['sizes']).toBeTruthy();
    expect(img.props['loading']).toBe('lazy');
  });

  it('falls back to the source URL unchanged for an https URL the loader does not know', async () => {
    const img = (await renderImg({
      ...cloudinaryImage,
      cloudinaryUrl: 'https://images.example.com/shelf.jpg',
    }))!;
    expect(img.props['src']).toBe('https://images.example.com/shelf.jpg');
    expect(img.props['srcSet']).toBeUndefined();
  });

  it('renders nothing for a non-https stored value (renderer does not trust the dataset)', async () => {
    expect(
      await renderImg({
        ...cloudinaryImage,
        cloudinaryUrl: 'http://res.cloudinary.com/x/image/upload/a.jpg',
      }),
    ).toBeUndefined();
  });

  it('wins over a Sanity asset when both are present', async () => {
    const img = (await renderImg({ ...sanityImage, cloudinaryUrl: DELIVERY }))!;
    expect(String(img.props['src'])).toContain('res.cloudinary.com');
  });
});

describe('Sanity uploads keep working, now with a srcset', () => {
  it('serves the asset with CDN width steps and the intrinsic size', async () => {
    const img = (await renderImg(sanityImage))!;
    expect(String(img.props['src'])).toContain(
      'cdn.sanity.io/images/abc/brand-a/shelf-1200x800.jpg',
    );
    const srcSet = String(img.props['srcSet']);
    for (const width of IMAGE_WIDTHS) expect(srcSet).toContain(`w=${width} ${width}w`);
    expect(img.props['width']).toBe(1200);
    expect(img.props['height']).toBe(800);
  });

  it('renders nothing without any source', async () => {
    expect(await renderImg({ _type: 'image', alt: 'x' })).toBeUndefined();
  });
});

describe('schema and loader agree on what a Cloudinary URL is', () => {
  it('CLOUDINARY_URL_PATTERN mirrors isCloudinaryUrl', () => {
    const cases = [
      DELIVERY,
      'https://res.cloudinary.com/demo/video/upload/clip.mp4',
      'https://res.cloudinary.com/demo/raw/upload/size.csv',
      'https://res.cloudinary.com/demo/image/fetch/http://x/y.jpg',
      'http://res.cloudinary.com/demo/image/upload/a.jpg',
      'https://images.example.com/shelf.jpg',
      'not a url',
    ];
    for (const value of cases) {
      expect(CLOUDINARY_URL_PATTERN.test(value), value).toBe(isCloudinaryUrl(value));
    }
  });

  it('the schema rejects a non-Cloudinary cloudinaryUrl and an image with no source at all', async () => {
    const doc = JSON.parse(JSON.stringify(pageFixture)) as Record<string, unknown> & {
      hero: { image: Record<string, unknown> };
    };
    doc.hero.image['cloudinaryUrl'] = 'https://images.example.com/shelf.jpg';
    expect(await validateDocument(doc, schemaTypes)).toEqual([
      {
        path: 'hero.image',
        message:
          'Must be a Cloudinary delivery URL (https://res.cloudinary.com/<cloud>/image/upload/…)',
      },
    ]);

    delete doc.hero.image['cloudinaryUrl'];
    delete doc.hero.image['asset'];
    expect(await validateDocument(doc, schemaTypes)).toEqual([
      { path: 'hero.image', message: 'Upload an image or paste its Cloudinary URL' },
    ]);
  });
});

describe('share image metadata from either source', () => {
  it('uses the loader for a Cloudinary ogImage and the CDN for a Sanity one', () => {
    const cloudinary = documentMetadata(
      { title: 'x', seo: { ogImage: cloudinaryImage } },
      '/pages/x',
      ctx,
    );
    expect(cloudinary.openGraph?.images).toEqual([
      {
        url: 'https://res.cloudinary.com/brand-alpha/image/upload/c_limit,w_1200,q_auto,f_auto/cms/spring-shelf.jpg',
        alt: cloudinaryImage.alt,
      },
    ]);
    const sanity = documentMetadata({ title: 'x', seo: { ogImage: sanityImage } }, '/pages/x', ctx);
    expect(String((sanity.openGraph?.images as { url: string }[])[0]?.url)).toContain(
      'cdn.sanity.io/images/abc/brand-a/shelf-1200x800.jpg',
    );
  });
});
