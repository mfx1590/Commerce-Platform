/**
 * The BI page (#480) per principal, with the report wrappers mocked and the REAL section guard:
 * - nav fixtures: analyst and owner see BI; store admin and support do not;
 * - a store admin on the route gets the 403 panel, and no report is requested;
 * - finance cards only for finance principals (analyst: absent, and the finance report is never requested);
 * - currency is a tab: EUR and GBP never share a chart, a total or a table;
 * - no customer identifier in any request or rendered table;
 * - the metrics dashboard (#604): its own currency tabs, finance metrics asked for only with finance, the live
 *   tiles fed (the client component is stubbed; its polling is tested in live-tiles.test.tsx), the CSV link, and
 *   the 503 panel when the analytics store is down.
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
  queryMetrics: vi.fn(),
}));
vi.mock('@/app/(hq)/bi/_api', () => api);
// expand() calls components as functions, so a hook (the retry button) has no renderer: the API panel is a stub
// naming its state, the rest of the module (the guard's 403 panel) stays real.
vi.mock('@/components/states/state-panel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ApiStatePanel: ({ status, what }: { status: number; what: string }) => (
    <p data-testid="api-state">
      {status} {what}
    </p>
  ),
}));
vi.mock('@/app/(hq)/bi/_components/live-tiles', () => ({
  LiveTiles: ({ initial, endpoint }: { initial: { rows: unknown[] }; endpoint: string }) => (
    <p data-testid="live-stub">
      live {endpoint} {initial.rows.length}
    </p>
  ),
}));

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

type Values = Record<string, number | null>;
const metricResult = (
  query: unknown,
  rows: {
    period?: string | null;
    currency: string;
    store_id?: string | null;
    product_id?: string | null;
    values: Values;
  }[],
  totals: { currency: string; values: Values }[],
) => ({
  query,
  generated_at: '2026-03-04T09:00:00Z',
  data_as_of: '2026-03-04T08:59:50Z',
  truncated: false,
  rows: rows.map((r) => ({
    period: null,
    store_id: null,
    product_id: null,
    refund_reason: null,
    provider: null,
    ...r,
  })),
  currency_totals: totals,
});

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
  api.queryMetrics.mockImplementation(async (q: { metrics: string[] }) =>
    ok(metricResult(q, [], [])),
  );
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

describe('the metrics dashboard (#604)', () => {
  const asks = (metric: string) =>
    api.queryMetrics.mock.calls.some(([q]) =>
      (q as { metrics: string[] }).metrics.includes(metric),
    );
  beforeEach(() => {
    api.queryMetrics.mockImplementation(async (q: { metrics: string[] }) => {
      if (q.metrics.includes('bookings_minor') && q.metrics.includes('refund_rate_bp'))
        return ok(
          metricResult(
            q,
            [
              {
                period: '2026-03-01',
                currency: 'EUR',
                store_id: A,
                values: { bookings_minor: 12200, refunds_minor: 2500, refund_rate_bp: 2049 },
              },
              {
                period: '2026-03-01',
                currency: 'GBP',
                store_id: B,
                values: { bookings_minor: 6000, refunds_minor: 0, refund_rate_bp: 0 },
              },
            ],
            [
              {
                currency: 'EUR',
                values: { bookings_minor: 12200, refunds_minor: 2500, refund_rate_bp: 2049 },
              },
              {
                currency: 'GBP',
                values: { bookings_minor: 6000, refunds_minor: 0, refund_rate_bp: 0 },
              },
            ],
          ),
        );
      if (q.metrics.includes('recognised_minor'))
        return ok(
          metricResult(
            q,
            [],
            [
              {
                currency: 'EUR',
                values: { bookings_minor: 12200, recognised_minor: 9700, captured_minor: 14000 },
              },
            ],
          ),
        );
      if (q.metrics.includes('units'))
        return ok(
          metricResult(
            q,
            [
              {
                currency: 'EUR',
                product_id: '00000000-0000-4000-8000-000000000071',
                values: { units: 4, product_net_minor: 8000 },
              },
            ],
            [],
          ),
        );
      if (q.metrics.includes('live_orders'))
        return ok(
          metricResult(
            q,
            [{ currency: 'EUR', store_id: A, values: { live_orders: 2, live_placed_minor: 5000 } }],
            [],
          ),
        );
      return ok(metricResult(q, [], []));
    });
  });

  it('has its own currency tabs: EUR by default, the KPIs and charts in EUR only', async () => {
    await renderAs('analyst', { from: '2026-03-01', to: '2026-03-04' });
    const tabs = screen.getByRole('navigation', { name: 'Metrics currency' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['EUR', 'GBP']);
    expect(within(tabs).getByRole('link', { name: 'EUR' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByText('20.49 %')).toBeTruthy();
    expect(screen.getByText('Bookings per day (EUR)')).toBeTruthy();
    expect(screen.getByText('Refunds per day (EUR)')).toBeTruthy();
    expect(screen.queryByText(/per day (GBP)/)).toBeNull();
  });

  it('an analyst never asks for a finance metric (it would be a 403) and sees no money views', async () => {
    await renderAs('analyst');
    expect(asks('recognised_minor') || asks('captured_minor') || asks('fee_minor')).toBe(false);
    expect(screen.queryByTestId('bi-money-views')).toBeNull();
  });

  it('the owner (finance) gets bookings vs recognised vs cash for the tab currency', async () => {
    await renderAs('owner');
    expect(asks('recognised_minor')).toBe(true);
    expect(
      screen.getByRole('link', { name: 'Download money views CSV' }).getAttribute('href'),
    ).toMatch(/^\/bi\/export\?table=money&/);
    const views = screen.getByTestId('bi-money-views');
    expect(
      within(views)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['€122.00', '€97.00', '€140.00']);
  });

  it('feeds the live tiles from the live query and links the CSV export of the window', async () => {
    await renderAs('analyst', { from: '2026-03-01', to: '2026-03-04' });
    expect(screen.getByTestId('live-stub').textContent).toBe('live /bi/live 1');
    const csv = screen.getAllByRole('link', { name: 'Download CSV' })[0]!;
    expect(csv.getAttribute('href')).toBe('/bi/export?table=period&from=2026-03-01&to=2026-03-04');
    // every table on the page has its own server-generated CSV with the same scope
    expect(
      screen.getByRole('link', { name: 'Download top products CSV' }).getAttribute('href'),
    ).toBe('/bi/export?table=products&from=2026-03-01&to=2026-03-04');
    // an analyst has no money views, so no money views CSV is offered (the API would answer 403)
    expect(screen.queryByRole('link', { name: 'Download money views CSV' })).toBeNull();
  });

  it('a 503 from the metrics API is a panel, never partial figures, and the v1 reports still render', async () => {
    api.queryMetrics.mockResolvedValue({
      ok: false,
      status: 503,
      error: { code: 'unavailable', message: 'Analytics store unavailable' },
    });
    await renderAs('analyst');
    expect(screen.queryByRole('navigation', { name: 'Metrics currency' })).toBeNull();
    expect(screen.queryByTestId('live-stub')).toBeNull();
    expect(screen.getAllByTestId('api-state').map((p) => p.textContent)).toEqual([
      '503 live metrics',
      '503 metrics',
    ]);
    expect(screen.getByRole('navigation', { name: 'Currency' })).toBeTruthy();
  });
});
