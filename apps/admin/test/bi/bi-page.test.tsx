/**
 * The BI page (#480) per principal, with the report wrappers mocked and the REAL section guard:
 * - nav fixtures: analyst and owner see BI; store admin and support do not;
 * - a store admin on the route gets the 403 panel, and no report is requested;
 * - finance cards only for finance principals (analyst: absent, and the finance report is never requested);
 * - currency is a tab: EUR and GBP never share a chart, a total or a table;
 * - no customer identifier in any request or rendered table.
 *
 * The page nests async server components (guard → report), so `expand()` resolves them before rendering.
 */
import { render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BiPage from '@/app/(hq)/bi/page';
import { visibleHqSections } from '@/lib/nav/navigation';
import { SEED, principals, type PrincipalKey } from '../fixtures/principals';

vi.mock('server-only', () => ({}));
const principalOf = vi.hoisted(() => ({ current: 'analyst' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('../fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));
const api = vi.hoisted(() => ({
  getHqSalesReport: vi.fn(),
  getHqFinanceReport: vi.fn(),
  getStoreStockReport: vi.fn(),
}));
vi.mock('@/app/(hq)/bi/_api', () => api);

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const A = SEED.stores.brandA;
const B = SEED.stores.brandB;
const C = SEED.stores.brandC;

const figures = (orders: number, total: number, refunded: number) => ({
  orders,
  gross_minor: total - 100,
  discount_minor: 50,
  shipping_minor: 100,
  tax_minor: 50,
  total_minor: total,
  refunded_minor: refunded,
  net_minor: total - refunded,
});

// Brand A sells in EUR and GBP, brand B in GBP, brand C in EUR. EUR has more orders, so it is the default tab.
const SALES = {
  from: '2026-03-01',
  to: '2026-03-04',
  generated_at: '2026-03-04T09:00:00Z',
  rows: [
    { store_id: A, day: '2026-03-01', currency: 'EUR', ...figures(2, 12200, 2500) },
    { store_id: C, day: '2026-03-02', currency: 'EUR', ...figures(3, 9000, 0) },
    { store_id: A, day: '2026-03-01', currency: 'GBP', ...figures(1, 7000, 7000) },
    { store_id: B, day: '2026-03-03', currency: 'GBP', ...figures(1, 6000, 600) },
  ],
  totals: [
    { store_id: A, currency: 'EUR', ...figures(2, 12200, 2500) },
    { store_id: C, currency: 'EUR', ...figures(3, 9000, 0) },
    { store_id: A, currency: 'GBP', ...figures(1, 7000, 7000) },
    { store_id: B, currency: 'GBP', ...figures(1, 6000, 600) },
  ],
  currency_totals: [
    { currency: 'EUR', ...figures(5, 21200, 2500) },
    { currency: 'GBP', ...figures(2, 13000, 7600) },
  ],
};

const reasons = { return: 0, cancellation: 0, goodwill: 2500, chargeback: 0 };
const FINANCE = {
  from: '2026-03-01',
  to: '2026-03-04',
  generated_at: '2026-03-04T09:00:00Z',
  fees_reconciled: false,
  rows: [
    {
      store_id: A,
      currency: 'EUR',
      captured_count: 2,
      captured_minor: 14000,
      fee_minor: 290,
      fee_unknown: 1,
      refunds: 1,
      refunded_minor: 2500,
      refunded_by_reason: reasons,
    },
  ],
  currency_totals: [
    {
      currency: 'EUR',
      captured_count: 2,
      captured_minor: 14000,
      fee_minor: 290,
      fee_unknown: 1,
      refunds: 1,
      refunded_minor: 2500,
      refunded_by_reason: reasons,
    },
  ],
};

const STOCK = {
  page: 1,
  limit: 20,
  total: 1,
  generated_at: '2026-03-04T09:00:00Z',
  items: [
    {
      stock_item_id: '00000000-0000-4000-8000-000000000051',
      sku: 'shared-tee-m',
      warehouse_id: '00000000-0000-4000-8000-000000000021',
      warehouse_code: 'wh-eu',
      on_hand: 40,
      reserved: 3,
      incoming: 0,
      available: 37,
    },
  ],
};

/** Resolves function components (async ones included) down to host elements, so `render` gets a plain tree. */
async function expand(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(expand));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function') {
    const out = (element.type as (p: unknown) => ReactNode | Promise<ReactNode>)(element.props);
    return expand(await out);
  }
  const children = element.props.children;
  if (children === undefined) return element;
  return { ...element, props: { ...element.props, children: await expand(children) } };
}

async function renderAs(key: PrincipalKey, params: Record<string, string> = {}) {
  principalOf.current = key;
  const tree = await BiPage({ searchParams: Promise.resolve(params) });
  return render(<>{await expand(tree)}</>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getHqSalesReport.mockResolvedValue(ok(SALES));
  api.getHqFinanceReport.mockResolvedValue(ok(FINANCE));
  api.getStoreStockReport.mockResolvedValue(ok(STOCK));
});

describe('nav fixtures', () => {
  it.each([
    ['analyst', true],
    ['owner', true],
    ['storeAdmin', false],
    ['support', false],
  ] as const)('%s sees BI: %s', (key, sees) => {
    expect(visibleHqSections(principals[key]).some((s) => s.id === 'bi')).toBe(sees);
  });
});

describe('the guard', () => {
  it.each(['storeAdmin', 'support'] as const)(
    '%s gets the 403 panel, not an empty chart, and no report is requested',
    async (key) => {
      await renderAs(key);
      expect(screen.getByText('You do not have access to this')).toBeTruthy();
      expect(screen.getByText(/analyst relation on organization:hq/)).toBeTruthy();
      expect(screen.queryByRole('img')).toBeNull();
      expect(api.getHqSalesReport).not.toHaveBeenCalled();
      expect(api.getHqFinanceReport).not.toHaveBeenCalled();
      expect(api.getStoreStockReport).not.toHaveBeenCalled();
    },
  );
});

describe('finance cards', () => {
  it('are absent for an analyst, and the finance report is never requested', async () => {
    await renderAs('analyst');
    expect(screen.queryByText('Finance')).toBeNull();
    expect(api.getHqFinanceReport).not.toHaveBeenCalled();
  });

  it('render for the owner (finance + analyst), fees labelled unreconciled', async () => {
    await renderAs('owner');
    expect(screen.getByText('Finance')).toBeTruthy();
    expect(screen.getByText('PSP fees — unreconciled')).toBeTruthy();
    expect(api.getHqFinanceReport).toHaveBeenCalledTimes(1);
  });

  it('a finance-only principal has no analyst relation, so the BI guard refuses it', async () => {
    await renderAs('finance');
    expect(screen.getByText('You do not have access to this')).toBeTruthy();
    expect(api.getHqFinanceReport).not.toHaveBeenCalled();
  });
});

describe('currency is a tab, never a sum', () => {
  it('defaults to the currency with most orders and shows only its figures', async () => {
    await renderAs('analyst', { from: '2026-03-01', to: '2026-03-04' });
    const tabs = screen.getByRole('navigation', { name: 'Currency' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['EUR', 'GBP']);
    expect(within(tabs).getByRole('link', { name: 'EUR' }).getAttribute('aria-current')).toBe(
      'page',
    );
    const charts = screen.getAllByRole('img');
    expect(charts).toHaveLength(2);
    for (const chart of charts) {
      expect(chart.getAttribute('aria-label')).toMatch(/\(EUR\)/);
      expect(chart.getAttribute('aria-label')).not.toMatch(/GBP/);
    }
    // EUR stores only (A and C), never B (GBP only); amounts formatted from minor units
    expect(charts[0]!.getAttribute('aria-label')).toBe(
      'Net revenue per day (EUR): brand-a, brand-c',
    );
    expect(screen.getAllByText('€97.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/£/)).toBeNull();
  });

  it('the GBP tab holds GBP only', async () => {
    await renderAs('analyst', { currency: 'GBP', from: '2026-03-01', to: '2026-03-04' });
    const charts = screen.getAllByRole('img');
    expect(charts[0]!.getAttribute('aria-label')).toBe(
      'Net revenue per day (GBP): brand-a, brand-b',
    );
    expect(screen.queryByText(/€/)).toBeNull();
    expect(api.getHqSalesReport).toHaveBeenCalledWith({ from: '2026-03-01', to: '2026-03-04' });
  });

  it('an unknown currency in the URL falls back to the first tab', async () => {
    await renderAs('analyst', { currency: 'CHF' });
    const tabs = screen.getByRole('navigation', { name: 'Currency' });
    expect(within(tabs).getByRole('link', { name: 'EUR' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});

describe('stock and privacy', () => {
  it('shows the first page of a store’s stock, brand A by default', async () => {
    await renderAs('analyst');
    expect(api.getStoreStockReport).toHaveBeenCalledWith(A);
    expect(screen.getByText('shared-tee-m')).toBeTruthy();
  });

  it('switches the stock tab to another store', async () => {
    await renderAs('owner', { stock: B });
    expect(api.getStoreStockReport).toHaveBeenCalledWith(B);
  });

  it('no customer identifier in any request or rendered table', async () => {
    const { container } = await renderAs('owner');
    const requests = JSON.stringify([
      ...api.getHqSalesReport.mock.calls,
      ...api.getHqFinanceReport.mock.calls,
      ...api.getStoreStockReport.mock.calls,
    ]);
    expect(requests).not.toMatch(/customer|email|name|phone|address/i);
    const headers = [...container.querySelectorAll('th')].map((th) => th.textContent ?? '');
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.join(' ')).not.toMatch(/customer|email|name|phone|address/i);
  });
});
