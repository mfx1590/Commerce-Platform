'use server';

import { revalidatePath } from 'next/cache';
import {
  archiveProduct,
  createCategory,
  createProduct,
  createVariant,
  publishProduct,
  updateProduct,
  updateVariant,
} from '@/lib/api/admin';
import { compact, compactList } from '@/lib/api/payload';
import type { AdminComponents } from '@/lib/api/admin-client';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import {
  categoryCreateSchema,
  fieldNames,
  productCreateSchema,
  variantCreateSchema,
  type CategoryCreateValues,
  type ProductCreateValues,
  type VariantCreateValues,
} from '@/lib/forms/schemas';

type Product = AdminComponents['Product'];

function invalid(): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
}

function revalidateProduct(storeId: string, productId?: string): void {
  revalidatePath(`/${storeId}/catalog`);
  if (productId !== undefined) revalidatePath(`/${storeId}/catalog/${productId}`);
}

/** `media` is a list of objects with optional fields, and `compact` is shallow — hence the split. */
function toProductBody(values: ProductCreateValues) {
  const { media, ...rest } = values;
  return {
    ...compact(rest),
    ...(media === undefined ? {} : { media: compactList(media) }),
  };
}

export async function createProductAction(
  storeId: string,
  values: ProductCreateValues,
): Promise<ActionResult<Product>> {
  const parsed = productCreateSchema.safeParse(values);
  if (!parsed.success) return invalid();

  const result = await createProduct(storeId, toProductBody(parsed.data));
  if (result.ok) revalidateProduct(storeId);
  return toActionResult(result, fieldNames(productCreateSchema));
}

export async function updateProductAction(
  storeId: string,
  productId: string,
  values: ProductCreateValues,
): Promise<ActionResult<Product>> {
  const parsed = productCreateSchema.safeParse(values);
  if (!parsed.success) return invalid();

  const result = await updateProduct(storeId, productId, toProductBody(parsed.data));
  if (result.ok) revalidateProduct(storeId, productId);
  return toActionResult(result, fieldNames(productCreateSchema));
}

/**
 * Publishing is a state change, not a form: the response carries the new `status` and
 * `published_at`, and the screen renders those rather than assuming success looked a certain way.
 */
export async function publishProductAction(
  storeId: string,
  productId: string,
): Promise<ActionResult<Product>> {
  const result = await publishProduct(storeId, productId);
  if (result.ok) revalidateProduct(storeId, productId);
  return toActionResult(result, []);
}

/**
 * Archive uses `DELETE`, but the contract is explicit that it archives rather than hard-deletes,
 * and answers `204` — so there is no product to render back and the caller re-reads.
 */
export async function archiveProductAction(
  storeId: string,
  productId: string,
): Promise<ActionResult<null>> {
  const result = await archiveProduct(storeId, productId);
  if (result.ok) revalidateProduct(storeId, productId);
  return toActionResult(result, []);
}

export async function createVariantAction(
  storeId: string,
  productId: string,
  values: VariantCreateValues,
): Promise<ActionResult<AdminComponents['Variant']>> {
  const parsed = variantCreateSchema.safeParse(values);
  if (!parsed.success) return invalid();

  // `compact` is shallow, and each price is its own object with an optional `compare_at_minor`.
  const { prices, ...rest } = parsed.data;
  const result = await createVariant(storeId, productId, {
    ...compact(rest),
    ...(prices === undefined ? {} : { prices: prices.map((price) => compact(price)) }),
  });
  if (result.ok) revalidateProduct(storeId, productId);
  return toActionResult(result, fieldNames(variantCreateSchema));
}

/**
 * Editing one variant. Prices are integer minor units all the way down, so the nested `compact` is
 * not optional: `compare_at_minor` is optional inside each price object and `compact` is shallow.
 */
export async function updateVariantAction(
  storeId: string,
  variantId: string,
  values: VariantCreateValues,
): Promise<ActionResult<AdminComponents['Variant']>> {
  const parsed = variantCreateSchema.safeParse(values);
  if (!parsed.success) return invalid();

  const { prices, ...rest } = parsed.data;
  const result = await updateVariant(storeId, variantId, {
    ...compact(rest),
    ...(prices === undefined ? {} : { prices: prices.map((price) => compact(price)) }),
  });
  if (result.ok) revalidatePath(`/${storeId}/catalog`);
  return toActionResult(result, fieldNames(variantCreateSchema));
}

export async function createCategoryAction(
  storeId: string,
  values: CategoryCreateValues,
): Promise<ActionResult<AdminComponents['Category']>> {
  const parsed = categoryCreateSchema.safeParse(values);
  if (!parsed.success) return invalid();

  const result = await createCategory(storeId, compact(parsed.data));
  if (result.ok) revalidatePath(`/${storeId}/catalog/categories`);
  return toActionResult(result, fieldNames(categoryCreateSchema));
}
