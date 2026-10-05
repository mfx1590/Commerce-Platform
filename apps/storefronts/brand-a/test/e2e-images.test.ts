import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductImage } from '@/components/product-image';
import {
  LOCAL_PLACEHOLDER,
  assertLocalImagesAllowed,
  isRemoteImage,
  localImagesEnabled,
  localPlaceholderLoader,
} from '@/lib/e2e-images';
import { refuseTestBuildOutsideLoopback } from '@/instrumentation-node';

/**
 * #327: under the e2e flag no product image leaves the machine, and a build made with the flag
 * refuses to start anywhere but a loopback origin.
 */
const PICSUM = 'https://picsum.photos/seed/brand-a-157/800/1000';
const CLOUDINARY = 'https://res.cloudinary.com/demo/image/upload/v1/sample.jpg';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('localImagesEnabled', () => {
  it('is on for exactly "1"', () => {
    expect(localImagesEnabled('1')).toBe(true);
    for (const value of [undefined, '', '0', 'true', ' 1']) {
      expect(localImagesEnabled(value), String(value)).toBe(false);
    }
  });
});

describe('isRemoteImage', () => {
  it('is an absolute http(s) URL and nothing else', () => {
    expect(isRemoteImage(PICSUM)).toBe(true);
    expect(isRemoteImage('HTTP://example.com/a.png')).toBe(true);
    expect(isRemoteImage('/e2e-placeholder.svg')).toBe(false);
    expect(isRemoteImage('data:image/png;base64,AAAA')).toBe(false);
  });
});

describe('localPlaceholderLoader', () => {
  it('answers the local placeholder at the requested width, never the source', () => {
    const url = localPlaceholderLoader({ src: PICSUM, width: 640, quality: 75 });
    expect(url).toBe(`${LOCAL_PLACEHOLDER}?w=640`);
    expect(url).not.toContain('picsum');
  });
});

describe('ProductImage', () => {
  const render = (src: string) =>
    renderToStaticMarkup(
      createElement(ProductImage, { src, alt: 'a product', width: 800, height: 1000 }),
    );

  it('without the flag, a seed image goes through the optimiser as before', () => {
    vi.stubEnv('E2E_LOCAL_IMAGES', '');
    const html = render(PICSUM);
    expect(html).toContain('/_next/image?url=https%3A%2F%2Fpicsum.photos');
  });

  it('with the flag, picsum and the CDN both become the local placeholder — no remote URL left', () => {
    vi.stubEnv('E2E_LOCAL_IMAGES', '1');
    for (const src of [PICSUM, CLOUDINARY]) {
      const html = render(src);
      expect(html).toContain(`${LOCAL_PLACEHOLDER}?w=`);
      expect(html).not.toMatch(/picsum|cloudinary|_next\/image/);
    }
  });
});

describe('assertLocalImagesAllowed', () => {
  it('lets a build without the flag run anywhere', () => {
    expect(() => assertLocalImagesAllowed(false, 'https://shop.example')).not.toThrow();
    expect(() => assertLocalImagesAllowed(false, undefined)).not.toThrow();
  });

  it('lets the flag run on a loopback origin, as the e2e server does', () => {
    for (const origin of ['http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100']) {
      expect(() => assertLocalImagesAllowed(true, origin), origin).not.toThrow();
    }
  });

  it('refuses the flag on a public origin, with no SITE_URL, or with one that does not parse', () => {
    for (const origin of ['https://shop.example', 'http://localhost.example', undefined, 'nope']) {
      expect(() => assertLocalImagesAllowed(true, origin), String(origin)).toThrow(
        /E2E_LOCAL_IMAGES .* must not be set in production/,
      );
    }
  });
});

describe('refuseTestBuildOutsideLoopback', () => {
  const exited = () => {
    const exit = vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }) as unknown as (code: number) => never;
    return exit;
  };

  it('exits a flagged build on a public origin, and says why', () => {
    vi.stubEnv('E2E_LOCAL_IMAGES', '1');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = exited();
    expect(() =>
      refuseTestBuildOutsideLoopback({ SITE_URL: 'https://shop.example' }, exit),
    ).toThrow('exit 1');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('must not be set in production'));
  });

  it('starts a flagged build on loopback, and any unflagged build', () => {
    const exit = exited();
    vi.stubEnv('E2E_LOCAL_IMAGES', '1');
    refuseTestBuildOutsideLoopback({ SITE_URL: 'http://localhost:3100' }, exit);
    vi.stubEnv('E2E_LOCAL_IMAGES', '');
    refuseTestBuildOutsideLoopback({ SITE_URL: 'https://shop.example' }, exit);
    expect(exit).not.toHaveBeenCalled();
  });
});
