'use server';

import { revalidatePath } from 'next/cache';
import {
  addProductMedia,
  createMediaUploadParams,
  deleteProductMedia,
  updateProductMedia,
} from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  altProblem,
  describeFormats,
  formatAllowed,
  isCloudinaryDeliveryUrl,
  isCloudinaryUploadUrl,
  safeFileName,
  SNIFF_BYTES,
  sniffImageFormat,
} from '@/lib/catalog/media';
import { MEDIA_MAX_BYTES } from '@/lib/catalog/media-limits.mjs';
import { actionError, toActionResult, type ActionResult } from '@/lib/forms/action-result';
import { mapServerError } from '@/lib/forms/server-errors';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';

type ProductMedia = AdminComponents['ProductMedia'];

/**
 * Product media (#870 wave 1 item 5, PR B; Fable review, security). Every action refuses before
 * the API unless the principal holds the operation's relation (store_staff on the store).
 *
 * The upload, in this order — each step refuses before the next:
 * 1. permission for `createMediaUploadParams` AND `addProductMedia`; product and variant ids;
 * 2. the alt text (required) and the file: present, not empty, at most the 10 MiB ceiling — read
 *    from its size, before any byte of it is read;
 * 3. its TYPE from its first bytes (magic numbers), never the name or the browser's MIME type;
 * 4. the signed parameters from `createMediaUploadParams` — server-side only, never sent to the
 *    browser — then the size against THIS upload's `max_bytes` and the format against its
 *    `allowed_formats`;
 * 5. the upload URL must be Cloudinary's upload endpoint exactly; the file is posted there with
 *    the signature (no redirect followed), and the answer's URL must be Cloudinary's delivery
 *    host — no URL anyone typed is ever fetched or stored;
 * 6. `addProductMedia` attaches it. When that fails, the image is on the image host but not on the
 *    product, and the message says so.
 *
 * The body of this action is capped by `experimental.serverActions.bodySizeLimit` (the 10 MiB
 * ceiling plus a 64 KiB multipart envelope): Next parses a server action's body before the action
 * runs, so that framework limit is the cap on the stream itself.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_TIMEOUT_MS = 60_000;

function refuse(message: string, field?: string): ActionResult<never> {
  return actionError(
    field === undefined
      ? { fieldErrors: {}, formError: message }
      : { fieldErrors: { [field]: message }, formError: null },
  );
}

function revalidateProduct(storeId: string, productId: string): void {
  revalidatePath(`/${storeId}/catalog`);
  revalidatePath(`/${storeId}/catalog/${productId}`);
}

export async function uploadProductMediaAction(
  storeId: string,
  productId: string,
  form: FormData,
): Promise<ActionResult<ProductMedia>> {
  for (const operation of ['createMediaUploadParams', 'addProductMedia'] as const) {
    const refused = await refuseUnlessPermitted(operation, storeId);
    if (refused !== null) return refused;
  }
  if (!UUID.test(productId)) return refuse('That product is not valid.');
  const variantRaw = form.get('variant_id');
  const variantId = typeof variantRaw === 'string' && variantRaw !== '' ? variantRaw : null;
  if (variantId !== null && !UUID.test(variantId))
    return refuse('That variant is not valid.', 'variant_id');

  const altRaw = form.get('alt');
  const alt = typeof altRaw === 'string' ? altRaw.trim() : '';
  const altMessage = altProblem(alt);
  if (altMessage !== null) return refuse(altMessage, 'alt');

  const file = form.get('file');
  if (!(file instanceof Blob) || file.size === 0)
    return refuse('Choose an image to upload.', 'file');
  if (file.size > MEDIA_MAX_BYTES) {
    return refuse(`The image is larger than ${MEDIA_MAX_BYTES / (1024 * 1024)} MB.`, 'file');
  }
  const format = sniffImageFormat(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
  if (format === null) {
    return refuse(
      'That file is not an image in a supported format (its content was checked, not its name).',
      'file',
    );
  }

  const name = safeFileName(file instanceof File ? file.name : 'image');
  const signed = await createMediaUploadParams(storeId, {
    product_id: productId,
    filename: name,
    content_type: `image/${format}`,
  });
  if (!signed.ok) {
    const failure = { status: signed.status, error: signed.error };
    const refusal = failure.status === 401 || failure.status === 403 ? failure : undefined;
    return actionError(mapServerError(failure), refusal);
  }
  const params = signed.data;
  if (file.size > params.max_bytes) {
    return refuse(
      `The image is larger than the ${Math.floor(params.max_bytes / (1024 * 1024))} MB this store accepts.`,
      'file',
    );
  }
  if (!formatAllowed(format, params.allowed_formats)) {
    return refuse(`This store accepts ${describeFormats(params.allowed_formats)} images.`, 'file');
  }
  if (!isCloudinaryUploadUrl(params.upload_url)) {
    // Whatever the API answered, a file only ever goes to Cloudinary's upload endpoint.
    return refuse('The image host is not configured as expected; nothing was uploaded.');
  }

  const body = new FormData();
  for (const [key, value] of Object.entries(params.params as Record<string, string | number>)) {
    body.append(key, String(value));
  }
  if (!body.has('timestamp')) body.append('timestamp', String(params.timestamp));
  body.append('api_key', params.api_key);
  body.append('signature', params.signature);
  body.append('file', file, name);

  let uploaded: { secure_url?: unknown };
  try {
    const response = await fetch(params.upload_url, {
      method: 'POST',
      body,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      return refuse(
        `The image host refused the upload (${response.status}); nothing was attached.`,
      );
    }
    uploaded = (await response.json()) as { secure_url?: unknown };
  } catch {
    return refuse('The upload did not finish; nothing was attached. Try again.');
  }
  const url = typeof uploaded.secure_url === 'string' ? uploaded.secure_url : '';
  if (!isCloudinaryDeliveryUrl(url)) {
    return refuse('The image host answered without a usable address; nothing was attached.');
  }

  const added = await addProductMedia(storeId, productId, {
    url,
    alt,
    ...(variantId === null ? {} : { variant_id: variantId }),
  });
  if (!added.ok) {
    const failure = { status: added.status, error: added.error };
    const refusal = failure.status === 401 || failure.status === 403 ? failure : undefined;
    const mapped = mapServerError(failure);
    return actionError(
      {
        fieldErrors: mapped.fieldErrors,
        formError: `The image was uploaded to the image host but not attached to the product: ${mapped.formError ?? failure.error.message}`,
      },
      refusal,
    );
  }
  revalidateProduct(storeId, productId);
  return { status: 'success', data: added.data };
}

/** Alt text and the variant an image belongs to (null = the whole product). */
export async function updateProductMediaAction(
  storeId: string,
  productId: string,
  mediaId: string,
  values: { alt?: string; variant_id?: string | null },
): Promise<ActionResult<ProductMedia>> {
  const refused = await refuseUnlessPermitted('updateProductMedia', storeId);
  if (refused !== null) return refused;
  if (!UUID.test(productId) || !UUID.test(mediaId)) return refuse('That image is not valid.');
  const patch: AdminComponents['ProductMediaPatch'] = {};
  if (values.alt !== undefined) {
    const message = altProblem(values.alt);
    if (message !== null) return refuse(message, 'alt');
    patch.alt = values.alt.trim();
  }
  if (values.variant_id !== undefined) {
    if (values.variant_id !== null && !UUID.test(values.variant_id))
      return refuse('That variant is not valid.', 'variant_id');
    patch.variant_id = values.variant_id;
  }
  const result = await updateProductMedia(storeId, productId, mediaId, patch);
  if (result.ok) revalidateProduct(storeId, productId);
  return toActionResult(result, ['alt', 'variant_id']);
}

/** Moves an image to `position` (0 = the first, the product's thumbnail). */
export async function moveProductMediaAction(
  storeId: string,
  productId: string,
  mediaId: string,
  position: number,
): Promise<ActionResult<ProductMedia>> {
  const refused = await refuseUnlessPermitted('updateProductMedia', storeId);
  if (refused !== null) return refused;
  if (!UUID.test(productId) || !UUID.test(mediaId)) return refuse('That image is not valid.');
  if (!Number.isInteger(position) || position < 0) return refuse('That position is not valid.');
  const result = await updateProductMedia(storeId, productId, mediaId, { position });
  if (result.ok) revalidateProduct(storeId, productId);
  return toActionResult(result, []);
}

export async function deleteProductMediaAction(
  storeId: string,
  productId: string,
  mediaId: string,
): Promise<ActionResult<null>> {
  const refused = await refuseUnlessPermitted('deleteProductMedia', storeId);
  if (refused !== null) return refused;
  if (!UUID.test(productId) || !UUID.test(mediaId)) return refuse('That image is not valid.');
  const result = await deleteProductMedia(storeId, productId, mediaId);
  if (result.ok) revalidateProduct(storeId, productId);
  return toActionResult(result, []);
}
