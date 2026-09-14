// Product media (task 2.3, #136): contract types of proposed/admin-api.media.yaml and the body validation the
// router runs until the operations are in admin-api.yaml.
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validationError } from '../../lib/errors';
import type { MediaRendition } from './cloudinary';

export interface ProductMedia {
  id: string;
  url: string;
  alt: string | null;
  position: number;
  variant_id: string | null;
  variants: Record<MediaRendition, string>;
}

export interface ProductMediaInput {
  url: string;
  alt: string;
  variant_id?: string | null;
  position?: number;
}

export interface ProductMediaPatch {
  alt?: string;
  variant_id?: string | null;
  position?: number;
}

export interface MediaUploadRequest {
  product_id: string;
  filename?: string;
  content_type?: string;
}

const uuidOrNull = { type: ['string', 'null'], format: 'uuid' } as const;

export const PRODUCT_MEDIA_INPUT_SCHEMA = {
  type: 'object',
  required: ['url', 'alt'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', format: 'uri', maxLength: 2000 },
    alt: { type: 'string', minLength: 1, maxLength: 500 },
    variant_id: uuidOrNull,
    position: { type: 'integer', minimum: 0 },
  },
} as const;

export const PRODUCT_MEDIA_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    alt: { type: 'string', minLength: 1, maxLength: 500 },
    variant_id: uuidOrNull,
    position: { type: 'integer', minimum: 0 },
  },
} as const;

export const MEDIA_UPLOAD_REQUEST_SCHEMA = {
  type: 'object',
  required: ['product_id'],
  additionalProperties: false,
  properties: {
    product_id: { type: 'string', format: 'uuid' },
    filename: { type: 'string', maxLength: 200 },
    content_type: { type: 'string', maxLength: 100 },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vInput = ajv.compile(PRODUCT_MEDIA_INPUT_SCHEMA);
const vPatch = ajv.compile(PRODUCT_MEDIA_PATCH_SCHEMA);
const vUpload = ajv.compile(MEDIA_UPLOAD_REQUEST_SCHEMA);

function problems(errors: ErrorObject[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors ?? []) out[e.instancePath || '/'] = e.message ?? 'invalid';
  return out;
}

function trimmedAlt(alt: string): string {
  const t = alt.trim();
  if (!t) throw validationError('alt text is required', { '/alt': 'must not be blank' });
  return t;
}

export function parseMediaInput(body: unknown): ProductMediaInput {
  if (!vInput(body)) throw validationError('invalid media item', problems(vInput.errors));
  const input = body as ProductMediaInput;
  return { ...input, alt: trimmedAlt(input.alt) };
}

export function parseMediaPatch(body: unknown): ProductMediaPatch {
  if (!vPatch(body)) throw validationError('invalid media patch', problems(vPatch.errors));
  const patch = body as ProductMediaPatch;
  if (Object.keys(patch).length === 0)
    throw validationError('empty media patch', { '/': 'give alt, variant_id or position' });
  return patch.alt === undefined ? patch : { ...patch, alt: trimmedAlt(patch.alt) };
}

export function parseUploadRequest(body: unknown): MediaUploadRequest {
  if (!vUpload(body)) throw validationError('invalid upload request', problems(vUpload.errors));
  return body as MediaUploadRequest;
}
