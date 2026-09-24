// The recovery-rate report (#148, CONTRACT CHANGE #245).
//
// Same rules as the attribution report: every number comes from rows this platform wrote — `cart_recovery`
// joined to `"order"` — never from a pixel or an email provider's "opened" count. The store's default currency,
// with other-currency carts excluded, exactly as `reports/attribution` does (manager decision 2026-09-08,
// revisited at Integration 2).
import type { ScopedClient } from '@platform/db';
import { notFound, validationError } from '../../lib/errors';
import type { AbandonedCartReport, AbandonedCartReportQuery } from './recovery-types';

interface ReportRow {
  abandoned_count: number;
  redeemed_count: number;
  recovered_count: number;
  abandoned_value: string;
  recovered_value: string;
}

function parseWindow(query: AbandonedCartReportQuery): { from: string; to: string } {
  const problems: Record<string, string> = {};
  const from = Date.parse(query.from ?? '');
  const to = Date.parse(query.to ?? '');
  if (Number.isNaN(from)) problems.from = 'date-time (required)';
  if (Number.isNaN(to)) problems.to = 'date-time (required)';
  if (!Number.isNaN(from) && !Number.isNaN(to) && to <= from) problems.to = 'must be after from';
  if (Object.keys(problems).length) throw validationError('invalid report window', problems);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * Abandoned carts in `[from, to)`, how many links were opened, how many carts came back, and what that was
 * worth.
 *
 * **A cart counts once.** A customer who opens the link three times and orders once is one recovery, because
 * the counters are over `cart_recovery` rows and there is exactly one per cart (#148). `recovered_value` is the
 * *order* total, not the cart total: what the customer actually paid after they came back, which is the number
 * anyone comparing recovery against its cost will want.
 *
 * **A cancelled order is not a recovery, in either column** (#250 review). `recovered_count` and
 * `recovered_value` both come through the same LEFT JOIN, which excludes cancelled orders — so a recovery that
 * was later cancelled counts as neither one recovery nor zero revenue, but as no recovery at all. Before this
 * it counted as *one recovery worth nothing*, which is a number that is wrong on its own terms. The rule also
 * matches the 2.1 attribution report's ("orders that count as revenue: … not cancelled"), so the same order is
 * never revenue in one marketing report and not the other.
 *
 * The **record** keeps `status = 'recovered'` either way: that is what happened to the cart. The **report**
 * counts recoveries that stuck: that is what they were worth. A record whose `recovered_order_id` was cleared
 * is excluded for the same reason.
 */
export async function abandonedCartReport(
  client: ScopedClient,
  storeId: string,
  query: AbandonedCartReportQuery,
): Promise<AbandonedCartReport> {
  const { from, to } = parseWindow(query);

  const store = await client.query<{ default_currency: string }>(
    `SELECT default_currency FROM store WHERE id = $1`,
    [storeId],
  );
  const currency = store.rows[0]?.default_currency;
  if (!currency) throw notFound('store', storeId);

  const res = await client.query<ReportRow>(
    `SELECT count(*)::int                                                          AS abandoned_count,
            count(*) FILTER (WHERE r.redeemed_at IS NOT NULL)::int                 AS redeemed_count,
            count(*) FILTER (WHERE r.status = 'recovered' AND o.id IS NOT NULL)::int AS recovered_count,
            COALESCE(sum(r.total_minor), 0)::text                                  AS abandoned_value,
            COALESCE(sum(o.total_minor) FILTER (WHERE r.status = 'recovered'), 0)::text AS recovered_value
       FROM cart_recovery r
       LEFT JOIN "order" o ON o.id = r.recovered_order_id AND o.status <> 'cancelled'
      WHERE r.store_id = $1
        AND r.currency = $2
        AND r.abandoned_at >= $3
        AND r.abandoned_at < $4`,
    [storeId, currency, from, to],
  );

  const row = res.rows[0] ?? {
    abandoned_count: 0,
    redeemed_count: 0,
    recovered_count: 0,
    abandoned_value: '0',
    recovered_value: '0',
  };

  return {
    from,
    to,
    currency,
    abandoned_count: row.abandoned_count,
    redeemed_count: row.redeemed_count,
    recovered_count: row.recovered_count,
    // No carts abandoned is a rate of 0, not a division by zero and not `null`: the report is a number a
    // dashboard renders, and "we abandoned nothing" is honestly 0% lost.
    recovery_rate:
      row.abandoned_count === 0
        ? 0
        : Math.round((row.recovered_count / row.abandoned_count) * 10_000) / 10_000,
    abandoned_value: { amount_minor: Number(row.abandoned_value), currency },
    recovered_value: { amount_minor: Number(row.recovered_value), currency },
  };
}
