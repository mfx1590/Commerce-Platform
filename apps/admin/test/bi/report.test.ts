/**
 * BI helpers (#480): the report window, currency tabs, fixed store colours and the per-store daily series — the
 * pure rules behind "one currency at a time, never summed".
 */
import { describe, expect, it } from 'vitest';
import { niceScale } from '@/app/(hq)/bi/_components/series-chart';
import {
  biHref,
  currencyTabs,
  dailySeries,
  daysOf,
  defaultWindow,
  pickCurrency,
  SERIES_COLORS,
  storeColors,
  windowFrom,
} from '@/app/(hq)/bi/_lib/report';

const NOW = new Date('2026-03-15T10:00:00Z');

describe('report window', () => {
  it('defaults to the last 30 UTC days including today, to exclusive', () => {
    expect(defaultWindow(NOW)).toEqual({ from: '2026-02-14', to: '2026-03-16' });
    expect(daysOf(defaultWindow(NOW))).toHaveLength(30);
  });

  it('keeps a valid window from the URL', () => {
    expect(windowFrom({ from: '2026-03-01', to: '2026-04-01' }, NOW)).toEqual({
      from: '2026-03-01',
      to: '2026-04-01',
    });
  });

  it.each([
    [{ from: '2026-03-02', to: '2026-03-01' }],
    [{ from: '2026-03-01', to: '2026-03-01' }],
    [{ from: '2025-01-01', to: '2026-03-01' }],
    [{ from: '2026-02-30', to: '2026-03-01' }],
    [{ from: '2026-03-01T00:00:00Z', to: '2026-03-02' }],
    [{ from: undefined, to: '2026-03-02' }],
  ])('falls back to the default for %j', (params) => {
    expect(windowFrom(params, NOW)).toEqual(defaultWindow(NOW));
  });

  it('lists every day, from inclusive and to exclusive', () => {
    expect(daysOf({ from: '2026-02-27', to: '2026-03-02' })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
  });

  it('builds links that keep the window', () => {
    expect(
      biHref({ from: '2026-03-01', to: '2026-04-01' }, { currency: 'GBP', stock: undefined }),
    ).toBe('/bi?from=2026-03-01&to=2026-04-01&currency=GBP');
  });
});

describe('currency tabs', () => {
  const totals = [
    { currency: 'GBP', orders: 3 },
    { currency: 'EUR', orders: 7 },
    { currency: 'USD', orders: 3 },
  ];

  it('one tab per currency, most orders first, ties alphabetical', () => {
    expect(currencyTabs(totals)).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('takes the requested currency only when the report has it', () => {
    const tabs = currencyTabs(totals);
    expect(pickCurrency(tabs, 'GBP')).toBe('GBP');
    expect(pickCurrency(tabs, 'CHF')).toBe('EUR');
    expect(pickCurrency(tabs, 'gbp')).toBe('EUR');
    expect(pickCurrency(tabs, undefined)).toBe('EUR');
    expect(pickCurrency([], 'EUR')).toBeNull();
  });
});

describe('store colours', () => {
  const stores = [
    { store_id: 'c', code: 'brand-c' },
    { store_id: 'a', code: 'brand-a' },
    { store_id: 'b', code: 'brand-b' },
  ];

  it('follow the store (fixed order by code), not its rank in a report', () => {
    const colors = storeColors(stores);
    expect(colors.get('a')).toBe(SERIES_COLORS[0]);
    expect(colors.get('b')).toBe(SERIES_COLORS[1]);
    expect(colors.get('c')).toBe(SERIES_COLORS[2]);
  });

  it('never invent a ninth hue', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      store_id: `s${i}`,
      code: `s-${String(i).padStart(2, '0')}`,
    }));
    const colors = storeColors(many);
    expect(colors.get('s7')).toBe(SERIES_COLORS[7]);
    expect(colors.get('s8')).toBeNull();
  });
});

describe('daily series', () => {
  const days = ['2026-03-01', '2026-03-02', '2026-03-03'];
  const rows = [
    { store_id: 'a', day: '2026-03-01', currency: 'EUR', net_minor: 1000, orders: 2 },
    { store_id: 'a', day: '2026-03-03', currency: 'EUR', net_minor: 500, orders: 1 },
    { store_id: 'a', day: '2026-03-01', currency: 'GBP', net_minor: 9999, orders: 9 },
    { store_id: 'b', day: '2026-03-02', currency: 'GBP', net_minor: 700, orders: 1 },
  ];

  it('one series per store in that currency, zero on days without sales', () => {
    expect(dailySeries(rows, 'EUR', days, 'net_minor')).toEqual([
      { storeId: 'a', values: [1000, 0, 500] },
    ]);
    expect(dailySeries(rows, 'GBP', days, 'orders')).toEqual([
      { storeId: 'a', values: [9, 0, 0] },
      { storeId: 'b', values: [0, 1, 0] },
    ]);
  });

  it('never mixes currencies: the EUR series holds no GBP amount', () => {
    const eur = dailySeries(rows, 'EUR', days, 'net_minor').flatMap((s) => s.values);
    expect(eur).not.toContain(9999);
  });
});

describe('chart scale', () => {
  it('rounds the axis to a nice maximum', () => {
    expect(niceScale(0)).toEqual({ max: 4, step: 1 });
    expect(niceScale(9700)).toEqual({ max: 10000, step: 2500 });
    expect(niceScale(3)).toEqual({ max: 4, step: 1 });
  });
});
