// #604 BI v2 data layer: the query bodies the dashboards send (shapes of the posted #603 contract) and the shaping
// of a MetricResult (never a sum across currencies; live labelled live; freshness).
import { describe, expect, it } from 'vitest';
import {
  currencies,
  forStore,
  freshness,
  liveQuery,
  liveTiles,
  MAX_ROWS,
  moneyViews,
  moneyViewsQuery,
  periodQuery,
  rateLabel,
  storeSeries,
  topProductsQuery,
  type MetricResult,
} from '@/app/(hq)/bi/_lib/metrics';

const A = '00000000-0000-4000-8000-000000000031';
const B = '00000000-0000-4000-8000-000000000032';
const w = { from: '2026-10-01', to: '2026-10-04' };

function result(
  rows: MetricResult['rows'],
  totals: MetricResult['currency_totals'] = [],
): MetricResult {
  return {
    query: periodQuery(w),
    generated_at: '2026-10-27T09:00:00Z',
    data_as_of: '2026-10-27T08:59:50Z',
    truncated: false,
    rows,
    currency_totals: totals,
  };
}
const row = (
  period: string | null,
  currency: string | null,
  store: string | null,
  values: MetricResult['rows'][number]['values'],
) => ({
  period,
  currency,
  store_id: store,
  product_id: null,
  refund_reason: null,
  provider: null,
  values,
});

describe('the queries', () => {
  it('stay inside the closed vocabulary and the limits', () => {
    expect(periodQuery(w)).toEqual({
      metrics: ['bookings_minor', 'refunds_minor', 'refund_rate_bp'],
      dimensions: ['store'],
      grain: 'day',
      ...w,
      limit: MAX_ROWS,
    });
    expect(moneyViewsQuery(w)).toMatchObject({ grain: 'total', dimensions: [] });
    expect(topProductsQuery(w, 5)).toMatchObject({
      order_by: { metric: 'units', direction: 'desc' },
      limit: 5,
    });
  });

  it('the live query is today (UTC), per store, day/total grain only', () => {
    expect(liveQuery(new Date('2026-10-27T23:59:00Z'))).toEqual({
      metrics: ['live_orders', 'live_placed_minor'],
      dimensions: ['store'],
      grain: 'total',
      from: '2026-10-27',
      to: '2026-10-28',
      limit: MAX_ROWS,
    });
  });

  it('forStore narrows to one store and keeps the other filters; no store leaves the query alone', () => {
    const q = { ...periodQuery(w), filters: { currencies: ['EUR'] } };
    expect(forStore(q, 'store-a').filters).toEqual({ currencies: ['EUR'], store_ids: ['store-a'] });
    expect(forStore(q, undefined)).toBe(q);
  });
});

describe('shaping', () => {
  it('currency tabs come from the totals, and money views never merge currencies', () => {
    const r = result(
      [],
      [
        {
          currency: 'GBP',
          values: { bookings_minor: 500, recognised_minor: 400, captured_minor: 450 },
        },
        {
          currency: 'EUR',
          values: { bookings_minor: 1000, recognised_minor: 900, captured_minor: 1000 },
        },
      ],
    );
    expect(currencies(r)).toEqual(['EUR', 'GBP']);
    expect(moneyViews(r, true)).toEqual([
      { currency: 'EUR', bookings_minor: 1000, recognised_minor: 900, captured_minor: 1000 },
      { currency: 'GBP', bookings_minor: 500, recognised_minor: 400, captured_minor: 450 },
    ]);
    // without finance the ledger and cash columns are not shown at all
    expect(moneyViews(r, false)[0]).toEqual({
      currency: 'EUR',
      bookings_minor: 1000,
      recognised_minor: null,
      captured_minor: null,
    });
  });

  it('store series per day in ONE currency; other currencies and empty days stay out / zero', () => {
    const r = result([
      row('2026-10-01', 'EUR', A, { bookings_minor: 100 }),
      row('2026-10-03', 'EUR', A, { bookings_minor: 300 }),
      row('2026-10-01', 'GBP', A, { bookings_minor: 999 }),
      row('2026-10-02', 'EUR', B, { bookings_minor: 50 }),
    ]);
    expect(
      storeSeries(r, 'bookings_minor', 'EUR', ['2026-10-01', '2026-10-02', '2026-10-03']),
    ).toEqual([
      { storeId: A, values: [100, 0, 300] },
      { storeId: B, values: [0, 50, 0] },
    ]);
  });

  it('live tiles: per store × currency, AOV half-up and null without orders', () => {
    const r = result([
      row(null, 'EUR', A, { live_orders: 3, live_placed_minor: 1000 }),
      row(null, 'GBP', A, { live_orders: 0, live_placed_minor: 0 }),
      row(null, 'EUR', B, { live_orders: 2, live_placed_minor: 501 }),
    ]);
    expect(liveTiles(r)).toEqual([
      { storeId: A, currency: 'EUR', orders: 3, placed_minor: 1000, aov_minor: 333 },
      { storeId: A, currency: 'GBP', orders: 0, placed_minor: 0, aov_minor: null },
      { storeId: B, currency: 'EUR', orders: 2, placed_minor: 501, aov_minor: 251 },
    ]);
  });

  it('freshness labels the age of the latest event and flags stale tiles', () => {
    const now = new Date('2026-10-27T09:00:00Z');
    expect(freshness('2026-10-27T08:59:48Z', now)).toEqual({
      label: 'Updated 12 s ago',
      stale: false,
    });
    expect(freshness('2026-10-27T08:50:00Z', now)).toEqual({
      label: 'Updated 10 min ago',
      stale: true,
    });
    expect(freshness(null, now)).toEqual({ label: 'No events yet', stale: true });
  });

  it('rates are shown from basis points, a dash when undefined', () => {
    expect(rateLabel(1234)).toBe('12.34 %');
    expect(rateLabel(null)).toBe('—');
  });
});
