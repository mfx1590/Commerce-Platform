// The attribution report (issue #145, `getAttributionReport` in Admin API 0.3.0).
//
// Where the numbers come from — and where they do NOT: every figure is `attribution` rows joined to `"order"`.
// No pixel, no client-side counter, no external analytics tool feeds this (docs/marketing-scope.md: "Server-side
// only; no client pixels required for the numbers we report"). That is why the report can be trusted when ad
// blockers strip trackers, and why it is the same number the accounting ledger will see.
//
// Campaign linking happens HERE, at report time, not at placement: `src/lib/attribution.ts` (window 1) writes
// `campaign_id` as NULL on purpose, so a campaign created or renamed after the fact still claims its orders.
// The match is case-insensitive on `utm_campaign` within the same store (#145).
//
// Currency (manager decision 2026-09-08): the report is aggregated in the store's default currency and orders in
// any other currency are excluded. `AttributionReport` has one `currency` for the whole document and no field to
// declare a mix, so inventing one would be a contract change; multi-currency orders do not exist yet. Revisit at
// Integration 2. The exclusion is documented in README.md.
import type { ScopedClient } from '@platform/db';
import { notFound, validationError } from '../../lib/errors';
import { TOUCHES, type AttributionReport, type AttributionReportQuery, type Touch } from './types';

/** Orders that count as revenue: placed inside the window, in the store's currency, not cancelled. */
const PLACED_ORDERS = `
  SELECT o.id, o.total_minor
    FROM "order" o
   WHERE o.store_id = $1
     AND o.currency = $2
     AND o.placed_at >= $3
     AND o.placed_at < $4
     AND o.status <> 'cancelled'`;

interface GroupRow {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  campaign_id: string | null;
  orders_count: number;
  revenue_minor: string;
}

function parseWindow(query: AttributionReportQuery): { from: string; to: string; touch: Touch } {
  const problems: Record<string, string> = {};
  const from = Date.parse(query.from ?? '');
  const to = Date.parse(query.to ?? '');
  if (Number.isNaN(from)) problems.from = 'date-time (required)';
  if (Number.isNaN(to)) problems.to = 'date-time (required)';
  if (!Number.isNaN(from) && !Number.isNaN(to) && to <= from) {
    problems.to = 'must be after from';
  }
  const touch = query.touch ?? 'last';
  if (!TOUCHES.includes(touch)) problems.touch = `one of ${TOUCHES.join(', ')}`;
  if (Object.keys(problems).length) throw validationError('invalid report window', problems);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), touch };
}

/**
 * Orders and revenue by utm source/medium/campaign for one touch model, over `[from, to)`.
 *
 * Grouping: one item per distinct (utm_source, utm_medium, utm_campaign) among the attribution rows of that
 * touch, plus one `direct` item for orders that carry no attribution row at all (a customer who typed the URL,
 * or a cart created before the storefront captured anything). Totals are the sum of every item, so
 * `totals.orders_count` equals the number of qualifying orders in the window.
 */
export async function attributionReport(
  client: ScopedClient,
  storeId: string,
  query: AttributionReportQuery,
): Promise<AttributionReport> {
  const { from, to, touch } = parseWindow(query);

  const store = await client.query<{ default_currency: string }>(
    `SELECT default_currency FROM store WHERE id = $1`,
    [storeId],
  );
  const currency = store.rows[0]?.default_currency;
  if (!currency) throw notFound('store', storeId);

  const params = [storeId, currency, from, to, touch];

  // The LATERAL join resolves the campaign per attribution row; `c.id` is functionally determined by
  // `utm_campaign`, so adding it to GROUP BY never splits a group. Ties (two campaigns sharing a utm_campaign)
  // resolve to the oldest one, deterministically.
  const grouped = await client.query<GroupRow>(
    `WITH placed AS (${PLACED_ORDERS})
     SELECT a.utm_source,
            a.utm_medium,
            a.utm_campaign,
            c.id                                    AS campaign_id,
            count(*)::int                           AS orders_count,
            COALESCE(sum(p.total_minor), 0)::text   AS revenue_minor
       FROM placed p
       JOIN attribution a ON a.order_id = p.id AND a.touch = $5
       LEFT JOIN LATERAL (
            SELECT cc.id
              FROM campaign cc
             WHERE cc.store_id = $1
               AND cc.utm_campaign IS NOT NULL
               AND a.utm_campaign IS NOT NULL
               AND lower(cc.utm_campaign) = lower(a.utm_campaign)
             ORDER BY cc.created_at, cc.id
             LIMIT 1
       ) c ON true
      GROUP BY a.utm_source, a.utm_medium, a.utm_campaign, c.id
      ORDER BY sum(p.total_minor) DESC, count(*) DESC, a.utm_source ASC NULLS LAST`,
    params,
  );

  const direct = await client.query<{ orders_count: number; revenue_minor: string }>(
    `WITH placed AS (${PLACED_ORDERS})
     SELECT count(*)::int AS orders_count, COALESCE(sum(p.total_minor), 0)::text AS revenue_minor
       FROM placed p
      WHERE NOT EXISTS (SELECT 1 FROM attribution a WHERE a.order_id = p.id AND a.touch = $5)`,
    params,
  );

  const items: AttributionReport['items'] = grouped.rows.map((r) => ({
    utm_source: r.utm_source,
    utm_medium: r.utm_medium,
    utm_campaign: r.utm_campaign,
    campaign_id: r.campaign_id,
    orders_count: r.orders_count,
    revenue: { amount_minor: Number(r.revenue_minor), currency },
  }));

  // Orders with no touch at all are reported as `direct` rather than dropped: the report's order count has to
  // reconcile with the store's order list, otherwise "revenue by channel" quietly loses money.
  const directRow = direct.rows[0];
  if (directRow && directRow.orders_count > 0) {
    items.push({
      utm_source: 'direct',
      utm_medium: null,
      utm_campaign: null,
      campaign_id: null,
      orders_count: directRow.orders_count,
      revenue: { amount_minor: Number(directRow.revenue_minor), currency },
    });
  }

  return {
    from,
    to,
    touch,
    currency,
    totals: {
      orders_count: items.reduce((n, i) => n + i.orders_count, 0),
      revenue: {
        amount_minor: items.reduce((n, i) => n + i.revenue.amount_minor, 0),
        currency,
      },
    },
    items,
  };
}
