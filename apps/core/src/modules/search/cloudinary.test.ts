// Cloudinary helpers (pure): credentials resolution, signature, upload params never carrying the secret,
// delivery-URL transformations with passthrough, and the next/image loader reference implementation.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildUploadParams,
  cloudinaryCredentialsFor,
  cloudinaryImageLoader,
  isCloudinaryUrl,
  publicIdSlug,
  renditionUrls,
  signParams,
  transformUrl,
} from './cloudinary';

const SECRET = 'top-secret-value-9f8e7d';
const creds = {
  cloudName: 'demo',
  apiKey: '123456789012345',
  apiSecret: SECRET,
  source: 'global' as const,
};

describe('credentials', () => {
  it('store triple wins over the global one; partial store triple is ignored; nothing → null', () => {
    const env = {
      CLOUDINARY_CLOUD_NAME: 'g',
      CLOUDINARY_API_KEY: 'gk',
      CLOUDINARY_API_SECRET: 'gs',
      CLOUDINARY_CLOUD_NAME_BRAND_A: 'a',
      CLOUDINARY_API_KEY_BRAND_A: 'ak',
      CLOUDINARY_API_SECRET_BRAND_A: 'as',
      CLOUDINARY_CLOUD_NAME_BRAND_B: 'b-only',
    };
    expect(cloudinaryCredentialsFor('brand-a', env)).toEqual({
      cloudName: 'a',
      apiKey: 'ak',
      apiSecret: 'as',
      source: 'store',
    });
    expect(cloudinaryCredentialsFor('brand-b', env)?.source).toBe('global');
    expect(cloudinaryCredentialsFor('brand-a', { CLOUDINARY_CLOUD_NAME: 'x' })).toBeNull();
    expect(cloudinaryCredentialsFor('brand-a', {})).toBeNull();
  });
});

describe('signing and upload params', () => {
  it('signature = sha1 of sorted k=v pairs joined by & plus the secret', () => {
    const sig = signParams(
      { timestamp: 1757332800, public_id: 'p', folder: 'products/brand-a' },
      SECRET,
    );
    const expected = createHash('sha1')
      .update(`folder=products/brand-a&public_id=p&timestamp=1757332800${SECRET}`)
      .digest('hex');
    expect(sig).toBe(expected);
    expect(signParams({ tags: ['a', 'b'] }, SECRET)).toBe(
      createHash('sha1').update(`tags=a,b${SECRET}`).digest('hex'),
    );
  });

  it('upload params carry the signed params, the public key and the signature — never the secret', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    const out = buildUploadParams(
      creds,
      {
        storeCode: 'brand-a',
        productId: '00000000-0000-4000-8000-000000000301',
        filename: 'Classic Tee (1).JPG',
      },
      { now, random: () => 'abc123' },
    );
    expect(out.upload_url).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    expect(out.cloud_name).toBe('demo');
    expect(out.api_key).toBe(creds.apiKey);
    expect(out.timestamp).toBe(Math.floor(now.getTime() / 1000));
    expect(out.params).toEqual({
      folder: 'products/brand-a',
      public_id: '00000000-classic-tee-1-abc123',
      timestamp: out.timestamp,
    });
    expect(out.signature).toBe(signParams(out.params, SECRET));
    expect(out.max_bytes).toBe(10 * 1024 * 1024);
    expect(out.allowed_formats).toContain('webp');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // the signature is a one-way hash of the secret: 40 hex chars, not reversible into it
    expect(out.signature).toMatch(/^[0-9a-f]{40}$/);
  });

  it('public ids are readable slugs', () => {
    expect(publicIdSlug('Classic Tee (1).JPG')).toBe('classic-tee-1');
    expect(publicIdSlug('   ')).toBe('media');
    expect(publicIdSlug(undefined)).toBe('media');
    expect(publicIdSlug('x'.repeat(100) + '.png')).toHaveLength(60);
  });
});

describe('delivery URLs', () => {
  const original =
    'https://res.cloudinary.com/demo/image/upload/v1700000000/products/brand-a/classic-tee.jpg';

  it('inserts the transformation after /upload/ and chains before an existing one', () => {
    expect(transformUrl(original, 'w_10')).toBe(
      'https://res.cloudinary.com/demo/image/upload/w_10/v1700000000/products/brand-a/classic-tee.jpg',
    );
    const already = 'https://res.cloudinary.com/demo/image/upload/e_grayscale/classic-tee.jpg';
    expect(transformUrl(already, 'w_10')).toBe(
      'https://res.cloudinary.com/demo/image/upload/w_10/e_grayscale/classic-tee.jpg',
    );
  });

  it('renditions thumb / pdp / zoom; non-Cloudinary URLs pass through untouched', () => {
    const r = renditionUrls(original);
    expect(r.thumb).toContain('/upload/c_fill,w_400,h_400,g_auto,q_auto,f_auto/');
    expect(r.pdp).toContain('/upload/c_limit,w_1200,q_auto,f_auto/');
    expect(r.zoom).toContain('/upload/c_limit,w_2400,q_auto,f_auto/');
    const unsplash = 'https://images.unsplash.com/photo-1?w=800';
    expect(renditionUrls(unsplash)).toEqual({ thumb: unsplash, pdp: unsplash, zoom: unsplash });
    expect(isCloudinaryUrl(original)).toBe(true);
    expect(isCloudinaryUrl(unsplash)).toBe(false);
    expect(isCloudinaryUrl('https://res.cloudinary.com.evil.com/demo/image/upload/x.jpg')).toBe(
      false,
    );
  });

  it('next/image loader: c_limit + width + quality (auto by default), passthrough for other hosts', () => {
    expect(cloudinaryImageLoader({ src: original, width: 640 })).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_limit,w_640,q_auto,f_auto/v1700000000/products/brand-a/classic-tee.jpg',
    );
    expect(cloudinaryImageLoader({ src: original, width: 1080.4, quality: 75 })).toContain(
      '/upload/c_limit,w_1080,q_75,f_auto/',
    );
    expect(cloudinaryImageLoader({ src: original, width: 100, quality: 0 })).toContain('q_auto');
    const other = 'https://images.unsplash.com/photo-1';
    expect(cloudinaryImageLoader({ src: other, width: 640 })).toBe(other);
  });
});
