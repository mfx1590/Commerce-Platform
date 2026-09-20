// Cloudinary without an SDK (task 2.3, #136): credentials per store from env, signed direct-upload parameters
// (SHA-1 over the sorted signed params + api secret — the secret never leaves this process), delivery-URL
// transformations (thumb / pdp / zoom) and the `next/image` loader reference implementation that packages/ui
// copies (REQUEST to window 3). Non-Cloudinary URLs pass through untouched everywhere.
import { createHash } from 'node:crypto';
import { envSuffix } from './config';

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  source: 'store' | 'global';
}

/**
 * `CLOUDINARY_CLOUD_NAME[_<CODE>]`, `CLOUDINARY_API_KEY[_<CODE>]`, `CLOUDINARY_API_SECRET[_<CODE>]`. A store-specific
 * triple wins; a partial triple is ignored. Null when nothing complete is set (URL passthrough mode).
 */
export function cloudinaryCredentialsFor(
  storeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): CloudinaryCredentials | null {
  const s = envSuffix(storeCode);
  const store = {
    cloudName: env[`CLOUDINARY_CLOUD_NAME_${s}`],
    apiKey: env[`CLOUDINARY_API_KEY_${s}`],
    apiSecret: env[`CLOUDINARY_API_SECRET_${s}`],
  };
  if (store.cloudName && store.apiKey && store.apiSecret)
    return {
      cloudName: store.cloudName,
      apiKey: store.apiKey,
      apiSecret: store.apiSecret,
      source: 'store',
    };
  const {
    CLOUDINARY_CLOUD_NAME: cloudName,
    CLOUDINARY_API_KEY: apiKey,
    CLOUDINARY_API_SECRET: apiSecret,
  } = env;
  if (cloudName && apiKey && apiSecret) return { cloudName, apiKey, apiSecret, source: 'global' };
  return null;
}

/** Cloudinary's signature: `k1=v1&k2=v2…` (keys sorted, arrays joined by `,`) + api_secret, SHA-1 hex. */
export function signParams(
  params: Record<string, string | number | string[]>,
  apiSecret: string,
): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k]!;
      return `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`;
    })
    .join('&');
  return createHash('sha1')
    .update(toSign + apiSecret)
    .digest('hex');
}

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'] as const;

export interface UploadParams {
  upload_url: string;
  cloud_name: string;
  api_key: string;
  timestamp: number;
  signature: string;
  params: Record<string, string | number>;
  max_bytes: number;
  allowed_formats: string[];
}

/** `Classic Tee (1).JPG` → `classic-tee-1`; empty → `media`. */
export function publicIdSlug(filename: string | undefined): string {
  const base = (filename ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'media';
}

/**
 * Parameters for a direct browser → Cloudinary upload of one product image into `products/<store_code>`.
 * Only the signed params, the public api_key and the signature are returned — never the secret.
 */
export function buildUploadParams(
  creds: CloudinaryCredentials,
  input: { storeCode: string; productId: string; filename?: string | undefined },
  opts: { now?: Date; random?: () => string } = {},
): UploadParams {
  const now = opts.now ?? new Date();
  const random = opts.random ?? (() => Math.random().toString(36).slice(2, 8));
  const timestamp = Math.floor(now.getTime() / 1000);
  const params: Record<string, string | number> = {
    folder: `products/${input.storeCode}`,
    public_id: `${input.productId.slice(0, 8)}-${publicIdSlug(input.filename)}-${random()}`,
    timestamp,
  };
  return {
    upload_url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(creds.cloudName)}/image/upload`,
    cloud_name: creds.cloudName,
    api_key: creds.apiKey,
    timestamp,
    signature: signParams(params, creds.apiSecret),
    params,
    max_bytes: UPLOAD_MAX_BYTES,
    allowed_formats: [...UPLOAD_ALLOWED_FORMATS],
  };
}

// ---- delivery URLs ----------------------------------------------------------------------------------------

export const MEDIA_RENDITIONS = ['thumb', 'pdp', 'zoom'] as const;
export type MediaRendition = (typeof MEDIA_RENDITIONS)[number];

/** Named transformations referenced by URL (never stored: `product_media.url` stays the original). */
export const RENDITION_TRANSFORMS: Record<MediaRendition, string> = {
  thumb: 'c_fill,w_400,h_400,g_auto,q_auto,f_auto',
  pdp: 'c_limit,w_1200,q_auto,f_auto',
  zoom: 'c_limit,w_2400,q_auto,f_auto',
};

const DELIVERY = /^(https?:\/\/res\.cloudinary\.com\/[^/]+\/(?:image|video|raw)\/upload)\/(.*)$/;

/** Prepends `transformation` to a Cloudinary delivery URL (chained before any existing one); passthrough otherwise. */
export function transformUrl(url: string, transformation: string): string {
  const m = url.match(DELIVERY);
  if (!m) return url;
  return `${m[1]}/${transformation}/${m[2]}`;
}

export function renditionUrl(url: string, rendition: MediaRendition): string {
  return transformUrl(url, RENDITION_TRANSFORMS[rendition]);
}

export function renditionUrls(url: string): Record<MediaRendition, string> {
  return {
    thumb: renditionUrl(url, 'thumb'),
    pdp: renditionUrl(url, 'pdp'),
    zoom: renditionUrl(url, 'zoom'),
  };
}

/**
 * Reference `next/image` loader (contract for windows 3/6/10 — packages/ui ships the copy):
 * `loader({ src, width, quality })` → `…/upload/c_limit,w_<width>,q_<quality|auto>,f_auto/<rest>`;
 * a non-Cloudinary `src` is returned unchanged (next.config `remotePatterns` still gates hosts).
 */
export function cloudinaryImageLoader(args: {
  src: string;
  width: number;
  quality?: number;
}): string {
  const w = Math.max(1, Math.round(args.width));
  const q =
    args.quality && args.quality > 0 && args.quality <= 100 ? Math.round(args.quality) : 'auto';
  return transformUrl(args.src, `c_limit,w_${w},q_${q},f_auto`);
}

export function isCloudinaryUrl(url: string): boolean {
  return DELIVERY.test(url);
}
