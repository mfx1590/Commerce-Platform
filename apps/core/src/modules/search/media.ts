// Product media service (task 2.3, #136): per-item add / patch / delete on `product_media` with positions kept
// contiguous (0..n-1, existing order preserved) after every change — window 4's Phase 1 note: a form that
// renumbers client-side still leaves gaps and duplicates the moment two clients edit; the server owns the
// numbering. Alt text is required on the way in. `product.thumbnail_url` follows position 0. Every change writes
// audit_log and a `product.updated` (changed_fields: ["media"]) event through the outbox on the same transaction.
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor, SYSTEM_ACTOR } from '../../lib/audit';
import { notFound, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import {
  buildUploadParams,
  cloudinaryCredentialsFor,
  renditionUrls,
  type CloudinaryCredentials,
  type UploadParams,
} from './cloudinary';
import {
  parseMediaInput,
  parseMediaPatch,
  parseUploadRequest,
  type ProductMedia,
} from './media-types';

interface MediaRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  url: string;
  alt: string | null;
  position: number;
}

interface ProductRow {
  id: string;
  handle: string;
  status: 'draft' | 'published' | 'archived';
}

const toContract = (m: MediaRow): ProductMedia => ({
  id: m.id,
  url: m.url,
  alt: m.alt,
  position: m.position,
  variant_id: m.variant_id,
  variants: renditionUrls(m.url),
});

async function loadProduct(tx: Queryable, storeId: string, productId: string): Promise<ProductRow> {
  const r = await tx.query<ProductRow>(
    `SELECT id, handle, status FROM product WHERE store_id = $1 AND id = $2 FOR UPDATE`,
    [storeId, productId],
  );
  const p = r.rows[0];
  if (!p) throw notFound('product', productId);
  return p;
}

async function loadMedia(tx: Queryable, productId: string): Promise<MediaRow[]> {
  const r = await tx.query<MediaRow>(
    `SELECT id, product_id, variant_id, url, alt, position FROM product_media
     WHERE product_id = $1 ORDER BY position, id`,
    [productId],
  );
  return r.rows;
}

async function assertVariantOfProduct(
  tx: Queryable,
  productId: string,
  variantId: string,
): Promise<void> {
  const r = await tx.query(`SELECT 1 FROM product_variant WHERE product_id = $1 AND id = $2`, [
    productId,
    variantId,
  ]);
  if (r.rowCount === 0)
    throw validationError('variant does not belong to this product', { variant_id: variantId });
}

/** Writes positions 0..n-1 in array order (only rows whose position changed) and the thumbnail. */
async function renumber(
  tx: Queryable,
  productId: string,
  ordered: MediaRow[],
): Promise<MediaRow[]> {
  for (const [i, m] of ordered.entries()) {
    if (m.position !== i) {
      await tx.query(`UPDATE product_media SET position = $2 WHERE id = $1`, [m.id, i]);
      m.position = i;
    }
  }
  await tx.query(`UPDATE product SET thumbnail_url = $2 WHERE id = $1`, [
    productId,
    ordered[0]?.url ?? null,
  ]);
  return ordered;
}

async function recordChange(
  tx: Queryable,
  client: ScopedClient,
  storeId: string,
  product: ProductRow,
  action: 'product.media.add' | 'product.media.update' | 'product.media.delete',
  before: MediaRow[],
  after: MediaRow[],
  actor: Actor,
): Promise<void> {
  const organizationId = client.context.organizationId;
  await writeAudit(tx, {
    organizationId,
    storeId,
    actor,
    action,
    entityType: 'product_media',
    entityId: product.id,
    before: before.map(toContract),
    after: after.map(toContract),
  });
  const variants = await tx.query<{ variant_id: string; sku: string; title: string }>(
    `SELECT id AS variant_id, sku, title FROM product_variant WHERE product_id = $1 ORDER BY position, sku`,
    [product.id],
  );
  await withEvents(tx, [
    await buildEvent({
      topic: 'product.updated',
      organizationId,
      storeId,
      aggregateType: 'product',
      aggregateId: product.id,
      payload: {
        product_id: product.id,
        handle: product.handle,
        status: product.status,
        changed_fields: ['media'],
        variants: variants.rows,
      },
      actor: eventActor(actor),
    }),
  ]);
}

export async function listProductMedia(
  client: ScopedClient,
  storeId: string,
  productId: string,
): Promise<ProductMedia[]> {
  return client.transaction(async (tx) => {
    await loadProduct(tx, storeId, productId);
    return (await loadMedia(tx, productId)).map(toContract);
  });
}

/** Appends (or inserts at `position`) one item; alt required; positions renumbered. */
export async function addProductMedia(
  client: ScopedClient,
  storeId: string,
  productId: string,
  body: unknown,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ProductMedia> {
  const input = parseMediaInput(body);
  return client.transaction(async (tx) => {
    const product = await loadProduct(tx, storeId, productId);
    if (input.variant_id) await assertVariantOfProduct(tx, productId, input.variant_id);
    const before = await loadMedia(tx, productId);
    const r = await tx.query<MediaRow>(
      `INSERT INTO product_media (organization_id, store_id, product_id, variant_id, url, alt, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, product_id, variant_id, url, alt, position`,
      [
        client.context.organizationId,
        storeId,
        productId,
        input.variant_id ?? null,
        input.url,
        input.alt,
        before.length, // provisional; renumber fixes it
      ],
    );
    const row = r.rows[0]!;
    const ordered = [...before];
    const at = Math.min(input.position ?? before.length, before.length);
    ordered.splice(at, 0, row);
    const after = await renumber(tx, productId, ordered);
    await recordChange(tx, client, storeId, product, 'product.media.add', before, after, actor);
    return toContract(row);
  });
}

/** Changes alt / variant / position (move); the others shift so positions stay contiguous. */
export async function updateProductMedia(
  client: ScopedClient,
  storeId: string,
  productId: string,
  mediaId: string,
  body: unknown,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ProductMedia> {
  const patch = parseMediaPatch(body);
  return client.transaction(async (tx) => {
    const product = await loadProduct(tx, storeId, productId);
    const before = await loadMedia(tx, productId);
    const idx = before.findIndex((m) => m.id === mediaId);
    if (idx < 0) throw notFound('media', mediaId);
    if (patch.variant_id) await assertVariantOfProduct(tx, productId, patch.variant_id);
    const sets: string[] = [];
    const params: unknown[] = [mediaId];
    if (patch.alt !== undefined) {
      params.push(patch.alt);
      sets.push(`alt = $${params.length}`);
    }
    if (patch.variant_id !== undefined) {
      params.push(patch.variant_id);
      sets.push(`variant_id = $${params.length}`);
    }
    if (sets.length > 0)
      await tx.query(`UPDATE product_media SET ${sets.join(', ')} WHERE id = $1`, params);
    const ordered = before.map((m) => ({ ...m }));
    const [moved] = ordered.splice(idx, 1);
    const item = { ...moved!, ...(patch.alt !== undefined ? { alt: patch.alt } : {}) };
    if (patch.variant_id !== undefined) item.variant_id = patch.variant_id;
    const to = Math.min(patch.position ?? idx, ordered.length);
    ordered.splice(to, 0, item);
    const after = await renumber(tx, productId, ordered);
    await recordChange(tx, client, storeId, product, 'product.media.update', before, after, actor);
    return toContract(after.find((m) => m.id === mediaId)!);
  });
}

/** Removes one item; the rest keep their order and are renumbered 0..n-1. */
export async function deleteProductMedia(
  client: ScopedClient,
  storeId: string,
  productId: string,
  mediaId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<void> {
  return client.transaction(async (tx) => {
    const product = await loadProduct(tx, storeId, productId);
    const before = await loadMedia(tx, productId);
    if (!before.some((m) => m.id === mediaId)) throw notFound('media', mediaId);
    await tx.query(`DELETE FROM product_media WHERE id = $1 AND product_id = $2`, [
      mediaId,
      productId,
    ]);
    const after = await renumber(
      tx,
      productId,
      before.filter((m) => m.id !== mediaId).map((m) => ({ ...m })),
    );
    await recordChange(tx, client, storeId, product, 'product.media.delete', before, after, actor);
  });
}

/**
 * Signed upload parameters for a product of the store. Null credentials (no Cloudinary configured) → the
 * router answers 409; the product must belong to the store (404 otherwise).
 */
export async function createUploadParams(
  client: ScopedClient,
  store: { id: string; code: string },
  body: unknown,
  creds: CloudinaryCredentials | null = cloudinaryCredentialsFor(store.code),
  opts: { now?: Date; random?: () => string } = {},
): Promise<UploadParams | null> {
  const req = parseUploadRequest(body);
  await client.transaction((tx) => loadProduct(tx, store.id, req.product_id));
  if (!creds) return null;
  return buildUploadParams(
    creds,
    { storeCode: store.code, productId: req.product_id, filename: req.filename },
    opts,
  );
}
