// Display names for the ids an answer holds (BI v2, #871 a3; decision 1: names come from Postgres at answer time, never
// from events — categories, sales channels and warehouses have no event, and product titles go stale after publish).
//
//   * ONE batched query per entity type, only for the ids the answer actually holds;
//   * through the CALLER's scoped client: RLS decides what may be named. An id the client cannot read is simply not
//     labelled (the screen shows the id's short form); a store-scoped answer only ever holds ids of its own stores'
//     data, so in practice that is a record deleted since;
//   * labels are display data: never put into a prompt (BI Q&A substitutes them after the model has answered).
import type { ScopedClient } from '@platform/db';
import type { MetricLabels, MetricRow } from './execute';

export type LabelKind = keyof MetricLabels;

const SQL: Readonly<Record<LabelKind, string>> = {
  store: 'SELECT id::text AS id, name AS label FROM store WHERE id = ANY($1::uuid[])',
  product: 'SELECT id::text AS id, title AS label FROM product WHERE id = ANY($1::uuid[])',
  category: 'SELECT id::text AS id, name AS label FROM product_category WHERE id = ANY($1::uuid[])',
  sales_channel:
    'SELECT id::text AS id, name AS label FROM sales_channel WHERE id = ANY($1::uuid[])',
  warehouse: 'SELECT id::text AS id, code AS label FROM warehouse WHERE id = ANY($1::uuid[])',
  // BI v2 wave 2 (#935): a promotion is labelled by its NAME, never its code (a single-use code can be personal)
  customer_group:
    'SELECT id::text AS id, name AS label FROM customer_group WHERE id = ANY($1::uuid[])',
  campaign: 'SELECT id::text AS id, name AS label FROM campaign WHERE id = ANY($1::uuid[])',
  promotion: 'SELECT id::text AS id, name AS label FROM promotion WHERE id = ANY($1::uuid[])',
};

const COLUMN: Readonly<Record<LabelKind, keyof MetricRow>> = {
  store: 'store_id',
  product: 'product_id',
  category: 'category_id',
  sales_channel: 'sales_channel_id',
  warehouse: 'warehouse_id',
  customer_group: 'customer_group_id',
  campaign: 'campaign_id',
  promotion: 'promotion_id',
};

/** The ids of each kind a set of rows holds. */
export function idsOf(
  rows: readonly Partial<MetricRow>[],
): Partial<Record<LabelKind, Set<string>>> {
  const out: Partial<Record<LabelKind, Set<string>>> = {};
  for (const r of rows)
    for (const kind of Object.keys(COLUMN) as LabelKind[]) {
      const v = r[COLUMN[kind]];
      if (typeof v === 'string' && v !== '') (out[kind] ??= new Set()).add(v);
    }
  return out;
}

export async function resolveLabels(
  client: Pick<ScopedClient, 'query'>,
  ids: Partial<Record<LabelKind, Iterable<string>>>,
): Promise<MetricLabels> {
  const out: MetricLabels = {};
  await Promise.all(
    (Object.keys(SQL) as LabelKind[]).map(async (kind) => {
      const list = [...(ids[kind] ?? [])];
      if (list.length === 0) return;
      const r = await client.query<{ id: string; label: string }>(SQL[kind], [list]);
      out[kind] = Object.fromEntries(r.rows.map((x) => [x.id, x.label]));
    }),
  );
  return out;
}
