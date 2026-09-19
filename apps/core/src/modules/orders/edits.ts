// Order edits before fulfilment (issue #105): a line's quantity down, or a line cancelled. Allowed while the order
// is pending | confirmed and nothing has shipped. Totals are recomputed with the SAME TaxCalculator the cart used
// (cart module seam, window 7's Stripe Tax included); money stays untouched — the difference is recorded on
// `order.metadata.edits[]` for window 7 to refund — and exactly one `order.updated` (`changed_fields`) is
// emitted through `transition()`. Admin API 0.3.0 has no order-edit operation: these are module functions until
// the CONTRACT CHANGE for `PATCH /admin/stores/{storeId}/orders/{orderId}/line-items/{lineItemId}` lands.
import type { Queryable, ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { conflict, notFound, validationError } from '../../lib/errors';
import {
  currentTaxCalculator,
  lineTaxOf,
  lineTotalWith,
  taxOn,
  type LineTaxRecord,
  type TaxMode,
  type PricingContext,
} from '../cart';
import { loadOrder, loadOrderLines, renderAdminOrder } from './read-model';
import { transition } from './service';
import type { AdminOrder, OrderLineRow, OrderRow } from './types';

export interface OrderEdit {
  at: string;
  line_item_id: string;
  sku: string;
  from_quantity: number;
  to_quantity: number;
  /** Order total before − after (positive = the customer is owed this much; window 7 refunds it). */
  delta_minor: number;
}

function assertEditable(o: OrderRow): void {
  if (
    o.fulfillment_status !== 'unfulfilled' ||
    !(o.status === 'pending' || o.status === 'confirmed')
  ) {
    throw conflict('order can no longer be edited', {
      field: o.fulfillment_status !== 'unfulfilled' ? 'fulfillment_status' : 'status',
      from: o.fulfillment_status !== 'unfulfilled' ? o.fulfillment_status : o.status,
      to: o.fulfillment_status !== 'unfulfilled' ? 'unfulfilled' : 'pending | confirmed',
    });
  }
}

/**
 * Recomputes every line's tax/total and the order totals from the current lines (shipping unchanged). Each line
 * re-prices in the tax mode frozen ON THAT LINE at placement (#221, #224 review) — never the store's current
 * setting, never a mode borrowed from a sibling line. One calculator call per mode present (one in practice: a
 * placement prices every line in one mode); shipping is taxed once, in the first line's mode. Tax goes on top of
 * the total only for the exclusive part.
 */
async function recomputeTotals(tx: Queryable, o: OrderRow): Promise<string[]> {
  const lines = await loadOrderLines(tx, o.id);
  const modeOf = new Map<string, TaxMode>(lines.map((l) => [l.id, lineTaxOf(l).mode]));
  const shippingMode: TaxMode = lines[0] ? modeOf.get(lines[0].id)! : 'exclusive';
  const byLine = new Map<string, { taxRateBp: number; taxMinor: number }>();
  let shippingTax = 0;
  for (const mode of ['exclusive', 'inclusive'] as const) {
    const group = lines.filter((l) => modeOf.get(l.id) === mode);
    if (group.length === 0) continue;
    const ctx: PricingContext & { shippingMinor: number } = {
      tx,
      organizationId: o.organization_id,
      storeId: o.store_id,
      salesChannelId: o.sales_channel_id,
      currency: o.currency,
      country: o.shipping_address.country,
      shippingAddress: o.shipping_address,
      lines: group.map((l) => ({
        lineItemId: l.id,
        variantId: l.variant_id ?? '',
        productId: l.product_id ?? '',
        categoryId: l.category_id,
        quantity: l.quantity,
        unitPriceMinor: Number(l.unit_price_minor),
        discountMinor: Number(l.discount_minor),
      })),
      shippingMinor: mode === shippingMode ? Number(o.shipping_minor) : 0,
      pricesIncludeTax: mode === 'inclusive',
    };
    const tax = await currentTaxCalculator().calculate(ctx);
    for (const t of tax.lines) byLine.set(t.lineItemId, t);
    if (mode === shippingMode) shippingTax = tax.shippingTaxMinor;
  }
  let subtotal = 0;
  let discount = 0;
  let taxMinor = shippingTax;
  let taxOnTop = shippingMode === 'exclusive' ? shippingTax : 0;
  for (const l of lines) {
    const mode = modeOf.get(l.id)!;
    const t = byLine.get(l.id);
    const bp = t?.taxRateBp ?? l.tax_rate_bp;
    const base = l.quantity * Number(l.unit_price_minor) - Number(l.discount_minor);
    const record: LineTaxRecord = {
      amount_minor: t?.taxMinor ?? taxOn(base, bp, mode === 'inclusive'),
      mode,
      bp,
    };
    subtotal += l.quantity * Number(l.unit_price_minor);
    discount += Number(l.discount_minor);
    taxMinor += record.amount_minor;
    if (mode === 'exclusive') taxOnTop += record.amount_minor;
    await tx.query(
      `UPDATE order_line_item SET tax_rate_bp = $2, tax_minor = $3, total_minor = $4, metadata = $5::jsonb,
         updated_at = now() WHERE id = $1`,
      [
        l.id,
        bp,
        record.amount_minor,
        lineTotalWith(base, record),
        JSON.stringify({ ...(l.metadata ?? {}), tax: record }),
      ],
    );
  }
  const total = subtotal - discount + Number(o.shipping_minor) + taxOnTop;
  const changed: string[] = ['line_items'];
  if (subtotal !== Number(o.subtotal_minor)) changed.push('subtotal_minor');
  if (discount !== Number(o.discount_minor)) changed.push('discount_minor');
  if (taxMinor !== Number(o.tax_minor)) changed.push('tax_minor');
  if (total !== Number(o.total_minor)) changed.push('total_minor');
  await tx.query(
    `UPDATE "order" SET subtotal_minor = $2, discount_minor = $3, tax_minor = $4, total_minor = $5, updated_at = now()
     WHERE id = $1`,
    [o.id, subtotal, discount, taxMinor, total],
  );
  return changed;
}

async function recordEdit(tx: Queryable, o: OrderRow, edit: OrderEdit): Promise<void> {
  const edits = Array.isArray(o.metadata.edits) ? (o.metadata.edits as OrderEdit[]) : [];
  await tx.query(`UPDATE "order" SET metadata = $2::jsonb, updated_at = now() WHERE id = $1`, [
    o.id,
    JSON.stringify({ ...o.metadata, edits: [...edits, edit] }),
  ]);
}

async function loadLine(tx: Queryable, orderId: string, lineItemId: string): Promise<OrderLineRow> {
  const line = (await loadOrderLines(tx, orderId)).find((l) => l.id === lineItemId);
  if (!line) throw notFound('line item', lineItemId);
  return line;
}

/** Lowers a line's quantity (1 ≤ quantity < current); `0` is `cancelLine`. */
export async function decreaseLineQuantity(
  client: ScopedClient,
  orderId: string,
  lineItemId: string,
  quantity: number,
  actor: Actor,
): Promise<AdminOrder> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw validationError('quantity must be a positive integer (use cancelLine for 0)', {
      quantity: 'integer >= 1',
    });
  }
  return client.transaction(async (tx) => {
    const o = await loadOrder(tx, orderId, true);
    assertEditable(o);
    const line = await loadLine(tx, orderId, lineItemId);
    if (quantity >= line.quantity) {
      throw validationError('quantity can only go down', {
        quantity: `less than the current ${line.quantity}`,
      });
    }
    await tx.query(`UPDATE order_line_item SET quantity = $2, updated_at = now() WHERE id = $1`, [
      lineItemId,
      quantity,
    ]);
    const changed = await recomputeTotals(tx, o);
    const after = await loadOrder(tx, orderId, false);
    await recordEdit(tx, after, {
      at: new Date().toISOString(),
      line_item_id: lineItemId,
      sku: line.sku,
      from_quantity: line.quantity,
      to_quantity: quantity,
      delta_minor: Number(o.total_minor) - Number(after.total_minor),
    });
    await transition(tx, orderId, { changed_fields: [...changed, 'metadata'], actor });
    return renderAdminOrder(tx, orderId);
  });
}

/** Removes a line entirely (the last line cannot be cancelled — cancel the order instead). */
export async function cancelLine(
  client: ScopedClient,
  orderId: string,
  lineItemId: string,
  actor: Actor,
): Promise<AdminOrder> {
  return client.transaction(async (tx) => {
    const o = await loadOrder(tx, orderId, true);
    assertEditable(o);
    const line = await loadLine(tx, orderId, lineItemId);
    const lines = await loadOrderLines(tx, orderId);
    if (lines.length === 1) {
      throw conflict('the last line cannot be cancelled; cancel the order', {
        field: 'line_items',
        from: 1,
        to: 0,
      });
    }
    await tx.query(`DELETE FROM order_line_item WHERE id = $1 AND order_id = $2`, [
      lineItemId,
      orderId,
    ]);
    const changed = await recomputeTotals(tx, o);
    const after = await loadOrder(tx, orderId, false);
    await recordEdit(tx, after, {
      at: new Date().toISOString(),
      line_item_id: lineItemId,
      sku: line.sku,
      from_quantity: line.quantity,
      to_quantity: 0,
      delta_minor: Number(o.total_minor) - Number(after.total_minor),
    });
    await transition(tx, orderId, { changed_fields: [...changed, 'metadata'], actor });
    return renderAdminOrder(tx, orderId);
  });
}
