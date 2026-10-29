import { describe, expect, it } from 'vitest';
import {
  ApiReadError,
  createAdminReportsClient,
  createFinanceClient,
  inclusiveEnd,
  type Fetch,
} from './clients.js';
import { addTo, compare, keyOf, type Keyed } from './diff.js';
import { assertWindow } from './identities.js';
import { renderReport, type ReconcileResult } from './run.js';

describe('compare', () => {
  it('is empty when every field of every key agrees', () => {
    const a: Keyed = new Map([
      [keyOf({ store: 's', day: 'd', currency: 'EUR' }), { total_minor: 100 }],
    ]);
    const b: Keyed = new Map([
      [keyOf({ store: 's', day: 'd', currency: 'EUR' }), { total_minor: 100 }],
    ]);
    expect(compare('x', { left: 'l', right: 'r' }, a, b, ['total_minor']).differences).toEqual([]);
  });

  it('a key on one side only is compared against 0, so a missing row is a difference', () => {
    const a: Keyed = new Map([['k1', { total_minor: 100, orders: 1 }]]);
    const r = compare('x', { left: 'l', right: 'r' }, a, new Map(), ['total_minor', 'orders']);
    expect(r.keys).toBe(1);
    expect(r.differences.map((d) => [d.key, d.field, d.left, d.right, d.diff])).toEqual([
      ['k1', 'total_minor', 100, 0, -100],
      ['k1', 'orders', 1, 0, -1],
    ]);
  });

  it('keys keep currencies apart: EUR and GBP are never summed together', () => {
    const a: Keyed = new Map();
    addTo(a, keyOf({ store: 's', currency: 'EUR' }), { total_minor: 100 });
    addTo(a, keyOf({ store: 's', currency: 'GBP' }), { total_minor: 100 });
    const b: Keyed = new Map();
    addTo(b, keyOf({ store: 's', currency: 'EUR' }), { total_minor: 200 });
    const r = compare('x', { left: 'l', right: 'r' }, a, b, ['total_minor']);
    expect(r.differences.map((d) => d.key)).toEqual([
      'store=s currency=EUR',
      'store=s currency=GBP',
    ]);
  });
});

describe('the API clients', () => {
  function fakeFetch(routes: Record<string, (url: URL) => { status: number; body: unknown }>) {
    const calls: { url: URL; auth: string | undefined }[] = [];
    const f: Fetch = async (raw, init) => {
      const url = new URL(raw);
      calls.push({ url, auth: init.headers.authorization });
      const route = routes[url.pathname];
      const r = route ? route(url) : { status: 404, body: { code: 'not_found' } };
      return { status: r.status, json: async () => r.body };
    };
    return { f, calls };
  }

  it('pages journal lines 100 at a time until the total, and sends the Finance API an INCLUSIVE end', async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ id: String(i) }));
    const { f, calls } = fakeFetch({
      '/accounting/v1/legal-entities/le-1/journal-lines': (u) => {
        const page = Number(u.searchParams.get('page'));
        const limit = Number(u.searchParams.get('limit'));
        return {
          status: 200,
          body: { items: all.slice((page - 1) * limit, page * limit), total: all.length },
        };
      },
    });
    const finance = createFinanceClient({
      baseUrl: 'http://acc.test/',
      token: 'word-token',
      fetch: f,
    });
    const lines = await finance.journalLines('le-1', '2026-10-01', '2026-11-01');
    expect(lines).toHaveLength(230);
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(calls[0]!.url.searchParams.get('limit')).toBe('100');
    expect(calls[0]!.url.searchParams.get('to')).toBe('2026-10-31');
    expect(calls[0]!.auth).toBe('Bearer word-token');
  });

  it('asks the Admin API with its EXCLUSIVE end, unchanged', async () => {
    const { f, calls } = fakeFetch({
      '/admin/hq/reports/sales': () => ({ status: 200, body: { rows: [] } }),
    });
    await createAdminReportsClient({ baseUrl: 'http://core.test', token: 't', fetch: f }).sales(
      '2026-10-01',
      '2026-11-01',
    );
    expect(calls[0]!.url.searchParams.get('to')).toBe('2026-11-01');
  });

  it('a non-200 answer is an ApiReadError with the status and the contract code', async () => {
    const { f } = fakeFetch({
      '/admin/hq/reports/finance': () => ({ status: 403, body: { code: 'forbidden' } }),
    });
    const admin = createAdminReportsClient({ baseUrl: 'http://core.test', token: 't', fetch: f });
    const err = await admin.finance('2026-10-01', '2026-10-02').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiReadError);
    expect(err).toMatchObject({ api: 'admin', status: 403, code: 'forbidden' });
  });

  it('inclusiveEnd steps back one UTC day across month and year ends', () => {
    expect(inclusiveEnd('2026-11-01')).toBe('2026-10-31');
    expect(inclusiveEnd('2027-01-01')).toBe('2026-12-31');
    expect(inclusiveEnd('2028-03-01')).toBe('2028-02-29');
  });
});

describe('the window and the report', () => {
  it('refuses a bad window or store', () => {
    expect(() => assertWindow({ from: '2026-10-02', to: '2026-10-01' })).toThrow(RangeError);
    expect(() =>
      assertWindow({ from: '2026-10-01', to: '2026-11-01', storeId: "x' OR 1=1" }),
    ).toThrow(RangeError);
    expect(() => assertWindow({ from: '2026-10-01', to: '2026-11-01' })).not.toThrow();
  });

  it('renders one block per identity and at most 20 differences each', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      identity: '1 bookings',
      key: `k${i}`,
      field: 'total_minor',
      left: i,
      right: 0,
      diff: -i,
    }));
    const r: ReconcileResult = {
      window: { from: '2026-10-01', to: '2026-11-01' },
      ok: false,
      ledger_lines: 7,
      identities: [
        { identity: '1 bookings', left: 'a', right: 'b', keys: 25, differences: many },
        { identity: '3a cash', left: 'c', right: 'd', keys: 3, differences: [] },
      ],
    };
    const text = renderReport(r);
    expect(text).toContain('DIFFERENCES');
    expect(text).toContain('FAIL 1 bookings');
    expect(text).toContain('ok   3a cash');
    expect(text).toContain('… 5 more');
    expect(text.split('\n').filter((l) => l.includes('total_minor:'))).toHaveLength(20);
  });
});
