import { describe, expect, it } from 'vitest';
import { cloudinaryImageLoader, isCloudinaryUrl, transformUrl } from '../src/index.js';

const DELIVERY = 'https://res.cloudinary.com/brand-alpha/image/upload/v1712000000/products/tee.jpg';

describe('isCloudinaryUrl', () => {
  it('accepts any cloud name — nothing is baked into the loader', () => {
    expect(isCloudinaryUrl(DELIVERY)).toBe(true);
    expect(isCloudinaryUrl('https://res.cloudinary.com/another-brand/image/upload/photo.png')).toBe(
      true,
    );
  });

  it('accepts the video and raw resource types', () => {
    expect(isCloudinaryUrl('https://res.cloudinary.com/demo/video/upload/clip.mp4')).toBe(true);
    expect(isCloudinaryUrl('https://res.cloudinary.com/demo/raw/upload/size.csv')).toBe(true);
  });

  it('rejects anything that is not a Cloudinary delivery URL', () => {
    expect(isCloudinaryUrl('https://picsum.photos/seed/brand-a-1/800/1000')).toBe(false);
    expect(isCloudinaryUrl('https://images.unsplash.com/photo-1?w=400')).toBe(false);
    // Right host, but not a delivery path: no transformation slot to insert into.
    expect(isCloudinaryUrl('https://res.cloudinary.com/demo/image/fetch/http://x/y.jpg')).toBe(
      false,
    );
    expect(isCloudinaryUrl('/local/relative.png')).toBe(false);
    // http, not https — the optimiser would refuse it anyway.
    expect(isCloudinaryUrl('http://res.cloudinary.com/demo/image/upload/a.jpg')).toBe(false);
  });
});

describe('transformUrl', () => {
  it('inserts the transformation right after /upload/', () => {
    expect(transformUrl(DELIVERY, 400)).toBe(
      'https://res.cloudinary.com/brand-alpha/image/upload/c_limit,w_400,q_auto,f_auto/v1712000000/products/tee.jpg',
    );
  });

  it('uses an explicit quality when given, q_auto otherwise', () => {
    expect(transformUrl(DELIVERY, 800, 75)).toContain('c_limit,w_800,q_75,f_auto');
    expect(transformUrl(DELIVERY, 800, undefined)).toContain('c_limit,w_800,q_auto,f_auto');
  });

  it('chains before a transformation already in the URL, so a stored crop still runs', () => {
    const cropped =
      'https://res.cloudinary.com/brand-alpha/image/upload/c_fill,g_auto,h_400,w_400/products/tee.jpg';
    expect(transformUrl(cropped, 200)).toBe(
      'https://res.cloudinary.com/brand-alpha/image/upload/c_limit,w_200,q_auto,f_auto/c_fill,g_auto,h_400,w_400/products/tee.jpg',
    );
  });

  it('returns a non-Cloudinary URL unchanged, so remotePatterns keeps gating hosts', () => {
    const seeded = 'https://picsum.photos/seed/brand-a-1/800/1000';
    expect(transformUrl(seeded, 400)).toBe(seeded);
  });

  it('only ever rewrites the first /upload/ segment', () => {
    const nested = 'https://res.cloudinary.com/brand-alpha/image/upload/v1/folder/upload/tee.jpg';
    expect(transformUrl(nested, 100)).toBe(
      'https://res.cloudinary.com/brand-alpha/image/upload/c_limit,w_100,q_auto,f_auto/v1/folder/upload/tee.jpg',
    );
  });
});

describe('cloudinaryImageLoader (the next/image loader shape)', () => {
  it('takes { src, width, quality } and returns the delivery URL', () => {
    expect(cloudinaryImageLoader({ src: DELIVERY, width: 1200, quality: 80 })).toBe(
      'https://res.cloudinary.com/brand-alpha/image/upload/c_limit,w_1200,q_80,f_auto/v1712000000/products/tee.jpg',
    );
  });

  it('is safe as a global loader: every other host passes through', () => {
    const src = 'https://images.unsplash.com/photo-1';
    expect(cloudinaryImageLoader({ src, width: 640 })).toBe(src);
  });
});
