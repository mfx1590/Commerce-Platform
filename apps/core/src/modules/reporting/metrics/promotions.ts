// The `promotions` source (BI v2 wave 2, #935 a1 R1): promotion usage and discount from POSTGRES, never from codes.
// Codes cannot carry these figures: an automatic promotion has no code, and stackable promotions combine on one order.
// The truth is the allocation the checkout froze on the order, `order.metadata.promotions[{promotion_id, code,
// discount_minor}]` (#230), which exists only in Postgres.
//
//   * Read through the CALLER's scoped client (RLS) and narrowed to the scope the route resolved, like every source.
//   * Orders that are not cancelled, by the UTC day of placement; an order with two stacked promotions counts in both,
//     each with its own share of the discount. Free shipping is not a discount here.
//   * The code is never selected: rows carry the promotion id only (labelled by its name, labels.ts).
//   * Answers in the compiled `out_*` / `m_*` shape, so the executor merges it like any other source.
import type { ScopedClient } from '@platform/db';
import type { MetricId } from './catalogue';
import type { PostgresSourceLoader } from './execute';
import type { MetricQuery } from './query';

const PERIOD: Readonly<Record<MetricQuery['grain'], string>> = {
  day: `to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
  week: `to_char(date_trunc('week', o.placed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
  month: `to_char(date_trunc('month', o.placed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
  total: 'NULL::text',
};

const AGGREGATE: Partial<Record<MetricId, string>> = {
  promotion_orders: 'count(DISTINCT o.id)',
  promotion_discount_minor: 'COALESCE(sum(p.discount_minor), 0)',
};

/** The statement and its parameters (exported for the unit test: no SQL text from the request). */
export function promotionsSql(
  q: MetricQuery,
  scope: readonly string[],
  metrics: readonly MetricId[],
  currencyKey: boolean,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [[...scope], q.from, q.to];
  const select = [`${PERIOD[q.grain]} AS out_period`];
  const group: string[] = q.grain === 'total' ? [] : ['1'];
  let n = 1;
  if (q.dimensions.includes('store')) {
    select.push('o.store_id::text AS out_store');
    group.push(String(++n));
  }
  if (q.dimensions.includes('promotion')) {
    select.push('p.promotion_id AS out_promotion');
    group.push(String(++n));
  }
  if (currencyKey) {
    select.push('o.currency::text AS out_currency');
    group.push(String(++n));
  }
  for (const m of metrics) select.push(`${AGGREGATE[m]!}::text AS m_${m}`);
  const where = [
    'o.store_id = ANY($1::uuid[])',
    `o.placed_at >= $2::date`,
    `o.placed_at < $3::date`,
    `o.status <> 'cancelled'`,
  ];
  if (q.filters.promotion_ids) {
    params.push(q.filters.promotion_ids);
    where.push(`p.promotion_id = ANY($${params.length}::text[])`);
  }
  if (q.filters.currencies) {
    params.push(q.filters.currencies);
    where.push(`o.currency = ANY($${params.length}::text[])`);
  }
  const sql =
    `SELECT ${select.join(', ')} FROM "order" o ` +
    `CROSS JOIN LATERAL jsonb_to_recordset(CASE WHEN jsonb_typeof(o.metadata->'promotions') = 'array' ` +
    `THEN o.metadata->'promotions' ELSE '[]'::jsonb END) AS p(promotion_id text, discount_minor bigint) ` +
    `WHERE ${where.join(' AND ')}` +
    (group.length > 0 ? ` GROUP BY ${group.join(', ')}` : '');
  return { sql, params };
}

export function promotionsLoader(client: Pick<ScopedClient, 'query'>): PostgresSourceLoader {
  return async (q, scope, metrics, currencyKey) => {
    const { sql, params } = promotionsSql(q, scope, metrics, currencyKey);
    const r = await client.query<Record<string, string | null>>(sql, params);
    return r.rows;
  };
}
