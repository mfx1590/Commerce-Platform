/**
 * Product media, server side (#870 wave 1 item 5, PR B; Fable review): the type read from the
 * file's bytes, the exact Cloudinary hosts, the limits pinned to the API's ceiling, and the upload
 * action refusing — before any API call or upload — a missing permission, a missing alt, an empty
 * or oversized file, a file that is not an image; then a size or format the signed params refuse,
 * an upload URL that is not Cloudinary's, an answer from another host. The signature never leaves
 * the server.
 */
/** @vitest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const principalOf = vi.hoisted(() => ({ current: 'storeStaff' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));
const api = vi.hoisted(() => ({
  createMediaUploadParams: vi.fn(),
  addProductMedia: vi.fn(),
  updateProductMedia: vi.fn(),
  deleteProductMedia: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const media = await import('@/lib/catalog/media');
const limits = await import('@/lib/catalog/media-limits.mjs');
const actions = await import('@/app/actions/media');

const STORE = '00000000-0000-4000-8000-000000000031';
const PRODUCT = '10000000-0000-4000-8000-000000000001';
const MEDIA = '60000000-0000-4000-8000-000000000001';
const SIGNATURE = 'test-signature-value';
const UPLOAD = 'https://api.cloudinary.com/v1_1/brand-a/image/upload';
const DELIVERED =
  'https://res.cloudinary.com/brand-a/image/upload/v1/products/brand-a/10000000-towel.jpg';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const bytes = (head: number[], size = 1024) => {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
};
const ascii = (text: string, size = 64) =>
  bytes(
    [...text].map((c) => c.charCodeAt(0)),
    size,
  );

function form(file: Blob | null, alt = 'Folded linen tea towel', name = 'towel.jpg', variant = '') {
  const data = new FormData();
  if (file !== null) data.append('file', new File([file], name, { type: 'image/jpeg' }));
  data.append('alt', alt);
  data.append('variant_id', variant);
  return data;
}

const signed = (overrides: Record<string, unknown> = {}) => ({
  ok: true as const,
  status: 200,
  data: {
    upload_url: UPLOAD,
    cloud_name: 'brand-a',
    api_key: 'public-api-key',
    timestamp: 1_763_500_000,
    signature: SIGNATURE,
    params: {
      folder: 'products/brand-a',
      public_id: '10000000-towel-ab12cd',
      timestamp: 1_763_500_000,
    },
    max_bytes: 10 * 1024 * 1024,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'],
    ...overrides,
  },
});

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeStaff';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ secure_url: DELIVERED, format: 'jpg' }), { status: 200 }),
  );
  api.createMediaUploadParams.mockResolvedValue(signed());
  api.addProductMedia.mockResolvedValue({
    ok: true,
    status: 201,
    data: {
      id: MEDIA,
      url: DELIVERED,
      alt: 'Folded linen tea towel',
      position: 0,
      variant_id: null,
      variants: { thumb: DELIVERED, pdp: DELIVERED, zoom: DELIVERED },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the type comes from the bytes, never the name', () => {
  it('recognises JPEG, PNG, GIF, WebP and AVIF; anything else is null', () => {
    expect(media.sniffImageFormat(bytes(JPEG))).toBe('jpeg');
    expect(media.sniffImageFormat(bytes(PNG))).toBe('png');
    expect(media.sniffImageFormat(ascii('GIF89a'))).toBe('gif');
    expect(media.sniffImageFormat(ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('webp');
    expect(media.sniffImageFormat(ascii('\u0000\u0000\u0000\u001cftypavif'))).toBe('avif');
    expect(media.sniffImageFormat(ascii('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(media.sniffImageFormat(ascii('%PDF-1.7'))).toBeNull();
    expect(media.sniffImageFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('jpeg matches "jpg" in allowed_formats; formats in words', () => {
    expect(media.formatAllowed('jpeg', ['jpg'])).toBe(true);
    expect(media.formatAllowed('gif', ['jpg', 'png'])).toBe(false);
    expect(media.describeFormats(['jpg', 'jpeg', 'png', 'webp'])).toBe('JPEG, PNG or WebP');
  });
});

describe('only Cloudinary, exactly', () => {
  it('the upload endpoint: https api.cloudinary.com /v1_1/<cloud>/image/upload, nothing else', () => {
    expect(media.isCloudinaryUploadUrl(UPLOAD)).toBe(true);
    for (const bad of [
      'http://api.cloudinary.com/v1_1/brand-a/image/upload',
      'https://api.cloudinary.com.evil.example/v1_1/brand-a/image/upload',
      'https://evil.example/v1_1/brand-a/image/upload',
      'https://api.cloudinary.com:8443/v1_1/brand-a/image/upload',
      'https://user:pass@api.cloudinary.com/v1_1/brand-a/image/upload',
      'https://api.cloudinary.com/v1_1/brand-a/image/upload?next=https://evil.example',
      'https://api.cloudinary.com/v1_1/brand-a/raw/upload',
      'not a url',
    ]) {
      expect(media.isCloudinaryUploadUrl(bad), bad).toBe(false);
    }
  });

  it('the delivery host: https res.cloudinary.com only', () => {
    expect(media.isCloudinaryDeliveryUrl(DELIVERED)).toBe(true);
    expect(media.isCloudinaryDeliveryUrl('http://res.cloudinary.com/x.jpg')).toBe(false);
    expect(media.isCloudinaryDeliveryUrl('https://res.cloudinary.com.evil.example/x.jpg')).toBe(
      false,
    );
  });
});

describe('the limits are the API ceiling, not more', () => {
  it('MEDIA_MAX_BYTES equals the core UPLOAD_MAX_BYTES; the body limit adds only the 64 KiB envelope', () => {
    const core = readFileSync(
      resolve(process.cwd(), '../core/src/modules/search/cloudinary.ts'),
      'utf8',
    );
    expect(core).toMatch(/UPLOAD_MAX_BYTES = 10 \* 1024 \* 1024;/);
    expect(limits.MEDIA_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(limits.SERVER_ACTION_BODY_LIMIT).toBe(10 * 1024 * 1024 + 64 * 1024);
    const config = readFileSync(resolve(process.cwd(), 'next.config.mjs'), 'utf8');
    expect(config).toMatch(/serverActions: \{ bodySizeLimit: SERVER_ACTION_BODY_LIMIT \}/);
  });
});

describe('the upload action refuses before any API call or upload', () => {
  const nothingCalled = () => {
    expect(api.createMediaUploadParams).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.addProductMedia).not.toHaveBeenCalled();
  };

  it('without store_staff on the store', async () => {
    principalOf.current = 'finance';
    expect(
      await actions.uploadProductMediaAction(STORE, PRODUCT, form(new Blob([bytes(JPEG)]))),
    ).toMatchObject({
      status: 'error',
      refusal: { status: 403 },
    });
    nothingCalled();
  });

  it.each([
    ['no alt text', form(new Blob([bytes(JPEG)]), '  '), 'alt'],
    ['no file', form(null), 'file'],
    ['an empty file', form(new Blob([])), 'file'],
    ['a file over 10 MiB', form(new Blob([bytes(JPEG, 10 * 1024 * 1024 + 1)])), 'file'],
    [
      'a text file named .jpg',
      form(new Blob([ascii('just text, not an image')]), undefined, 'towel.jpg'),
      'file',
    ],
    [
      'an SVG',
      form(new Blob([ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')]), undefined, 'towel.svg'),
      'file',
    ],
  ])('%s', async (_, data, field) => {
    const result = await actions.uploadProductMediaAction(STORE, PRODUCT, data);
    expect(result).toMatchObject({ status: 'error', fieldErrors: { [field]: expect.any(String) } });
    nothingCalled();
  });

  it('a product or variant id that is not a uuid', async () => {
    expect(
      (await actions.uploadProductMediaAction(STORE, '../x', form(new Blob([bytes(JPEG)])))).status,
    ).toBe('error');
    expect(
      (
        await actions.uploadProductMediaAction(
          STORE,
          PRODUCT,
          form(new Blob([bytes(JPEG)]), undefined, 'a.jpg', 'nope'),
        )
      ).status,
    ).toBe('error');
    nothingCalled();
  });
});

describe('after the signed params, before the upload', () => {
  it("a file larger than THIS upload's max_bytes", async () => {
    api.createMediaUploadParams.mockResolvedValue(signed({ max_bytes: 512 }));
    expect(
      await actions.uploadProductMediaAction(STORE, PRODUCT, form(new Blob([bytes(JPEG)]))),
    ).toMatchObject({
      fieldErrors: { file: expect.stringContaining('larger') },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a format the params do not allow (a real PNG when only JPEG is allowed)', async () => {
    api.createMediaUploadParams.mockResolvedValue(signed({ allowed_formats: ['jpg'] }));
    expect(
      await actions.uploadProductMediaAction(
        STORE,
        PRODUCT,
        form(new Blob([bytes(PNG)]), undefined, 'towel.jpg'),
      ),
    ).toMatchObject({
      fieldErrors: { file: 'This store accepts JPEG images.' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an upload URL that is not Cloudinary’s: nothing is posted anywhere', async () => {
    api.createMediaUploadParams.mockResolvedValue(
      signed({ upload_url: 'https://evil.example/upload' }),
    );
    expect(
      (await actions.uploadProductMediaAction(STORE, PRODUCT, form(new Blob([bytes(JPEG)]))))
        .status,
    ).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.addProductMedia).not.toHaveBeenCalled();
  });
});

describe('the upload', () => {
  it('posts the file with the signed params to Cloudinary only (no redirect), attaches the delivered URL, and never returns the signature', async () => {
    const result = await actions.uploadProductMediaAction(
      STORE,
      PRODUCT,
      form(new Blob([bytes(JPEG)])),
    );
    expect(api.createMediaUploadParams).toHaveBeenCalledWith(STORE, {
      product_id: PRODUCT,
      filename: 'towel.jpg',
      content_type: 'image/jpeg',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(UPLOAD);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const sent = init.body as FormData;
    expect(sent.get('signature')).toBe(SIGNATURE);
    expect(sent.get('api_key')).toBe('public-api-key');
    expect(sent.get('folder')).toBe('products/brand-a');
    expect(sent.get('public_id')).toBe('10000000-towel-ab12cd');
    expect(sent.getAll('timestamp')).toEqual(['1763500000']);
    expect(sent.get('file')).toBeInstanceOf(Blob);
    expect(api.addProductMedia).toHaveBeenCalledWith(STORE, PRODUCT, {
      url: DELIVERED,
      alt: 'Folded linen tea towel',
    });
    expect(result.status).toBe('success');
    expect(JSON.stringify(result)).not.toContain(SIGNATURE);
  });

  it('an answer from another host is not attached', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ secure_url: 'https://evil.example/x.jpg' }), { status: 200 }),
    );
    expect(
      await actions.uploadProductMediaAction(STORE, PRODUCT, form(new Blob([bytes(JPEG)]))),
    ).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('nothing was attached'),
    });
    expect(api.addProductMedia).not.toHaveBeenCalled();
  });

  it('the image host refusing, or the upload failing, attaches nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    expect(
      await actions.uploadProductMediaAction(STORE, PRODUCT, form(new Blob([bytes(JPEG)]))),
    ).toMatchObject({
      formError: expect.stringContaining('refused the upload (400)'),
    });
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(
      await actions.uploadProductMediaAction(STORE, PRODUCT, form(new Blob([bytes(JPEG)]))),
    ).toMatchObject({
      formError: 'The upload did not finish; nothing was attached. Try again.',
    });
    expect(api.addProductMedia).not.toHaveBeenCalled();
  });

  it('uploaded but not attached is said as such', async () => {
    api.addProductMedia.mockResolvedValue({
      ok: false,
      status: 404,
      error: { code: 'not_found', message: 'product not found' },
    });
    expect(
      await actions.uploadProductMediaAction(STORE, PRODUCT, form(new Blob([bytes(JPEG)]))),
    ).toMatchObject({
      formError: expect.stringContaining('uploaded to the image host but not attached'),
    });
  });
});

describe('edit, move, delete', () => {
  it('refused without store_staff, before the API', async () => {
    principalOf.current = 'analyst';
    for (const result of [
      await actions.updateProductMediaAction(STORE, PRODUCT, MEDIA, { alt: 'x' }),
      await actions.moveProductMediaAction(STORE, PRODUCT, MEDIA, 1),
      await actions.deleteProductMediaAction(STORE, PRODUCT, MEDIA),
    ]) {
      expect(result).toMatchObject({ status: 'error', refusal: { status: 403 } });
    }
    expect(api.updateProductMedia).not.toHaveBeenCalled();
    expect(api.deleteProductMedia).not.toHaveBeenCalled();
  });

  it('an empty alt is refused; only what changed is sent', async () => {
    api.updateProductMedia.mockResolvedValue({ ok: true, status: 200, data: {} });
    expect(
      await actions.updateProductMediaAction(STORE, PRODUCT, MEDIA, { alt: ' ' }),
    ).toMatchObject({
      fieldErrors: { alt: expect.any(String) },
    });
    await actions.updateProductMediaAction(STORE, PRODUCT, MEDIA, { variant_id: null });
    expect(api.updateProductMedia).toHaveBeenCalledWith(STORE, PRODUCT, MEDIA, {
      variant_id: null,
    });
  });

  it('move takes a whole position ≥ 0; delete calls the API', async () => {
    api.updateProductMedia.mockResolvedValue({ ok: true, status: 200, data: {} });
    api.deleteProductMedia.mockResolvedValue({ ok: true, status: 204, data: null });
    expect((await actions.moveProductMediaAction(STORE, PRODUCT, MEDIA, -1)).status).toBe('error');
    await actions.moveProductMediaAction(STORE, PRODUCT, MEDIA, 2);
    expect(api.updateProductMedia).toHaveBeenCalledWith(STORE, PRODUCT, MEDIA, { position: 2 });
    expect((await actions.deleteProductMediaAction(STORE, PRODUCT, MEDIA)).status).toBe('success');
  });
});
