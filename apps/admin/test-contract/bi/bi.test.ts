/**
 * The BI section's wrappers against the real spec (#480): Prism answers from admin-api.yaml, so a wrong path or a
 * missing query parameter is an error from the mock rather than a green test. Prism is spawned here, so
 * `pnpm --filter @platform/admin test:contract` needs nothing running.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, startPrism, type PrismHandle } from '../prism';

/** Its own port, set before the modules under test are imported (they resolve the base URL at module scope). */
const BASE = 'http://127.0.0.1:4217';
process.env['ADMIN_API_URL'] = BASE;
process.env['MOCK_ADMIN_API_URL'] = BASE;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'contract-test' }),
  requireSession: async () => ({ accessToken: 'contract-test' }),
}));

const bi = await import('@/app/(hq)/bi/_api');

let prism: PrismHandle;
const WINDOW = { from: '2026-03-01', to: '2026-04-01' };

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => {
  prism?.stop();
});

describe('the BI wrappers reach the paths the contract documents', () => {
  it('HQ sales: rows, per-store totals and per-currency totals, each amount beside its currency', async () => {
    const res = await bi.getHqSalesReport(WINDOW);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) {
      expect(Array.isArray(res.data.rows)).toBe(true);
      for (const row of [...res.data.rows, ...res.data.totals, ...res.data.currency_totals]) {
        expect(row.currency).toMatch(/^[A-Z]{3}$/);
        expect(Number.isInteger(row.net_minor)).toBe(true);
      }
    }
  });

  it('HQ finance: fees_reconciled is false', async () => {
    const res = await bi.getHqFinanceReport(WINDOW);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) expect(res.data.fees_reconciled).toBe(false);
  });

  it('store stock: the first page of pool rows', async () => {
    const res = await bi.getStoreStockReport(SEED_STORE_ID);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) {
      expect(res.data.page).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(res.data.items)).toBe(true);
    }
  });

  it('a window that is not a date is refused by the spec', async () => {
    const res = await bi.getHqSalesReport({ from: 'yesterday', to: '2026-04-01' });
    expect(res.ok).toBe(false);
  });
});
