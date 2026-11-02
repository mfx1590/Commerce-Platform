// The live golden set's product catalogue (#7 of the 2026-11-02 real-model runs). generateMonth gives every order
// line a fresh variant and publishes no product, so fct_order_line.product_id was NULL everywhere and "top 5
// products" had one combined row to rank. This publishes PRODUCTS_PER_STORE products per store, each line's variant
// going to one of them with skewed weights, so a ranking by units or net sales has a clear top and a long tail.
// Deterministic (line order), and event ids are derived, so the month is the same on every run.
import { makeEvent, type EventEnvelope, type EventEnvelopeV1Base } from '@platform/events';

export const PRODUCTS_PER_STORE = 8;
/** how many of every 30 lines go to product 1, 2 … 8: a skewed, never-tied share */
const WEIGHTS = [9, 7, 5, 4, 2, 1, 1, 1] as const;
const SLOTS = WEIGHTS.flatMap((w, p) => Array.from({ length: w }, () => p));

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
/** a stable uuid per (store number, product number) */
const productId = (store: number, product: number) =>
  `00000000-0000-4000-8000-${hex(0x7e0000 + store * 0x100 + product, 12)}`;
const eventId = (store: number, product: number) =>
  `00000000-0000-4000-9000-${hex(0x7e0000 + store * 0x100 + product, 12)}`;

/** One product.published event per (store, product), its variants the generated lines assigned to it. */
export function catalogueFor(
  events: readonly EventEnvelopeV1Base[],
  organizationId: string,
): EventEnvelopeV1Base[] {
  const byStore = new Map<string, { variant_id: string; sku: string }[][]>();
  const lineNo = new Map<string, number>();
  for (const e of events) {
    if (e.topic !== 'order.placed' || e.store_id === null) continue;
    const placed = e as unknown as EventEnvelope<'order.placed'>;
    const buckets =
      byStore.get(e.store_id) ??
      Array.from({ length: PRODUCTS_PER_STORE }, () => [] as { variant_id: string; sku: string }[]);
    byStore.set(e.store_id, buckets);
    for (const l of placed.payload.line_items) {
      if (!l.variant_id) continue;
      const n = lineNo.get(e.store_id) ?? 0;
      lineNo.set(e.store_id, n + 1);
      buckets[SLOTS[n % SLOTS.length]!]!.push({ variant_id: l.variant_id, sku: l.sku });
    }
  }
  const out: EventEnvelopeV1Base[] = [];
  [...byStore].forEach(([storeId, buckets], s) =>
    buckets.forEach((variants, p) => {
      if (variants.length === 0) return;
      out.push(
        makeEvent({
          topic: 'product.published',
          organizationId,
          storeId,
          aggregateType: 'product',
          aggregateId: productId(s, p),
          eventId: eventId(s, p),
          occurredAt: new Date('2026-09-20T00:00:00.000Z'),
          payload: {
            product_id: productId(s, p),
            handle: `golden-${s}-${p + 1}`,
            title: `Golden product ${p + 1}`,
            category_id: null,
            variants: variants.map((v) => ({ ...v, title: 'Golden variant' })),
            published_at: '2026-09-20T00:00:00.000Z',
          },
        }) as unknown as EventEnvelopeV1Base,
      );
    }),
  );
  return out;
}
