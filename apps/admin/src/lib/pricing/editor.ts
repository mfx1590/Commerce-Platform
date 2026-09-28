/**
 * The prices editor's rows: one per variant of the loaded products, carrying the price this list
 * holds for it today (read from `variant.prices` by `price_list_id` — the contract has no
 * per-list read), and the diff that becomes the upsert.
 *
 * Pure. No PII is involved: variants are SKUs, titles and money.
 */

import type { AdminComponents } from '../api/admin-client';
import type { CsvResolution } from './csv';

type Product = AdminComponents['Product'];

export interface EditorRow {
  variantId: string;
  sku: string;
  /** "Classic Tee · M / Red" */
  label: string;
  /** What the list holds today, or null when the variant has no price in it. */
  current: { amount_minor: number; compare_at_minor: number | null; min_quantity: number } | null;
}

export function editorRows(products: readonly Product[], priceListId: string): EditorRow[] {
  return products.flatMap((product) =>
    product.variants.map((variant) => {
      const price = variant.prices.find((entry) => entry.price_list_id === priceListId);
      return {
        variantId: variant.id,
        sku: variant.sku,
        label: `${product.title} · ${variant.title}`,
        current:
          price === undefined
            ? null
            : {
                amount_minor: price.amount_minor,
                compare_at_minor: price.compare_at_minor,
                min_quantity: price.min_quantity,
              },
      };
    }),
  );
}

export interface EditedPrice {
  amount_minor: number | null;
  compare_at_minor: number | null;
  min_quantity: number;
}

/** Only rows whose values differ from what the list holds; an untouched row is never re-sent. */
export function changedPrices(
  rows: readonly EditorRow[],
  edits: Readonly<Record<string, EditedPrice>>,
): {
  variant_id: string;
  amount_minor: number;
  compare_at_minor: number | null;
  min_quantity: number;
}[] {
  const out: ReturnType<typeof changedPrices> = [];
  for (const row of rows) {
    const edit = edits[row.variantId];
    if (edit === undefined || edit.amount_minor === null) continue;
    const same =
      row.current !== null &&
      row.current.amount_minor === edit.amount_minor &&
      row.current.compare_at_minor === edit.compare_at_minor &&
      row.current.min_quantity === edit.min_quantity;
    if (same) continue;
    out.push({
      variant_id: row.variantId,
      amount_minor: edit.amount_minor,
      compare_at_minor: edit.compare_at_minor,
      min_quantity: edit.min_quantity,
    });
  }
  return out;
}

/** What the CSV parser needs to turn SKUs into variant ids. */
export function csvResolution(rows: readonly EditorRow[], currency: string): CsvResolution {
  return {
    bySku: new Map(rows.map((row) => [row.sku, { variantId: row.variantId, label: row.label }])),
    byVariantId: new Map(rows.map((row) => [row.variantId, row.label])),
    currency,
  };
}
