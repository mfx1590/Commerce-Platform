/**
 * Product media rules (#870 wave 1 item 5, PR B). Pure — no React, no `next/*`, no I/O — so the
 * upload action and the tests share them.
 *
 * - The type of an upload is read from its first bytes (magic numbers), never from the file name
 *   or the browser's MIME type, and must be one of the formats the API allows for that upload.
 * - Files go only to Cloudinary's upload endpoint and come back only from its delivery host; any
 *   other URL is refused (no URL uploads, nothing fetched from a URL anyone typed).
 * - Every image needs alt text before it is publish-quality: said where it is missing.
 */

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif';

/** How many leading bytes `sniffImageFormat` needs. */
export const SNIFF_BYTES = 16;

const ascii = (bytes: Uint8Array, from: number, text: string) =>
  [...text].every((char, i) => bytes[from + i] === char.charCodeAt(0));

/**
 * The image format from the file's first bytes, or null when it is none of the five. JPEG
 * `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; GIF `GIF87a` / `GIF89a`; WebP `RIFF····WEBP`; AVIF an
 * ISO-BMFF `ftyp` box whose brand is `avif` or `avis`.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  ) {
    return 'png';
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))) return 'gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
  if (
    bytes.length >= 12 &&
    ascii(bytes, 4, 'ftyp') &&
    (ascii(bytes, 8, 'avif') || ascii(bytes, 8, 'avis'))
  ) {
    return 'avif';
  }
  return null;
}

/** Whether `format` is in the API's `allowed_formats` (which names JPEG as `jpg` and/or `jpeg`). */
export function formatAllowed(format: ImageFormat, allowed: readonly string[]): boolean {
  const names = allowed.map((name) => name.toLowerCase());
  return format === 'jpeg'
    ? names.includes('jpeg') || names.includes('jpg')
    : names.includes(format);
}

/** In words, for the refusal: "JPEG, PNG, WebP, AVIF or GIF". */
export function describeFormats(allowed: readonly string[]): string {
  const words: Record<string, string> = {
    jpg: 'JPEG',
    jpeg: 'JPEG',
    png: 'PNG',
    webp: 'WebP',
    avif: 'AVIF',
    gif: 'GIF',
  };
  const list = [...new Set(allowed.map((name) => words[name.toLowerCase()] ?? name.toUpperCase()))];
  return list.length <= 1
    ? (list[0] ?? 'none')
    : `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`;
}

/**
 * The only place a file is ever posted: `https://api.cloudinary.com/v1_1/<cloud>/image/upload`
 * (what `createMediaUploadParams` answers). Anything else is refused, whatever the API returned.
 */
export function isCloudinaryUploadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.cloudinary.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      /^\/v1_1\/[A-Za-z0-9_-]+\/image\/upload$/.test(url.pathname) &&
      url.search === ''
    );
  } catch {
    return false;
  }
}

/** The only URL an uploaded image may be stored as: Cloudinary's delivery host, over https. */
export function isCloudinaryDeliveryUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com' && url.port === '';
  } catch {
    return false;
  }
}

/** The longest alt text accepted (screen readers read it whole; keep it a sentence). */
export const ALT_MAX = 300;

/** Why an alt text is not acceptable, or null. Required: an image without one is not publish-quality. */
export function altProblem(raw: string): string | null {
  const alt = raw.trim();
  if (alt === '') return 'Describe the image (alt text): it is read to people who cannot see it.';
  if (alt.length > ALT_MAX) return `Keep the alt text to ${ALT_MAX} characters.`;
  return null;
}

/** The images of a product still missing alt text (for the panel's warning). */
export function missingAlt(media: readonly { alt: string | null }[]): number {
  return media.filter((item) => (item.alt ?? '').trim() === '').length;
}

/** A file name safe to pass on (the core slugs it again): no path, at most 100 characters. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  return base.replace(/[^\w.\- ]+/g, '').slice(0, 100) || 'image';
}
