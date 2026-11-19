/**
 * BI v2 views (#871) as rendered: the Overview's figures, comparison, definitions, breakdown,
 * drill-down and "What changed"; Products by name and "stock but no sales"; Inventory health's
 * answer to "do we need to order anything?" with its honest states.
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricQuery, MetricResult } from '@/app/(hq)/bi/_v2/model';
import {
  catalogue,
  inventory,
  ITEM,
  movers,
  PROD,
  PROD_2,
  STORE_A,
  STORE_B,
  totals,
  WH,
} from './bi-v2-fixtures';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/bi',
}));
const biApi = vi.hoisted(() => ({ listMetrics: vi.fn(), queryMetrics: vi.fn() }));
vi.mock('@/app/(hq)/bi/_api', () => biApi);
const v2Api = vi.hoisted(() => ({ listMetricMovers: vi.fn(), getInventoryHealth: vi.fn() }));
vi.mock('@/app/(hq)/bi/_v2/api', () => v2Api);
vi.mock('@/app/(hq)/bi/_v2/actions', () => ({ exportBiCsvAction: vi.fn() }));

const { OverviewView } = await import('@/app/(hq)/bi/_v2/components/overview');
const { ProductsView } = await import('@/app/(hq)/bi/_v2/components/products');
const { InventoryView } = await import('@/app/(hq)/bi/_v2/components/inventory');

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const RAW = { from: '2026-11-01', to: '2026-11-15' };

const VALUES: Record<string, number> = {
  net_sales_minor: 300000,
  gross_sales_minor: 340000,
  discounts_minor: 20000,
  shipping_minor: 15000,
  tax_minor: 30000,
  refunds_minor: 5000,
  net_bookings_minor: 355000,
  orders: 42,
  units: 90,
  aov_minor: 8452,
  items_per_order_bp: 21429,
};
const PREVIOUS: Record<string, number> = { ...VALUES, net_sales_minor: 250000, orders: 40 };

function answer(body: MetricQuery): MetricResult {
  if (body.dimensions.includes('store')) {
    return {
      ...totals(body.metrics, {}),
      rows: [
        { currency: 'JPY', store_id: STORE_A, values: { net_sales_minor: 200000, orders: 30 } },
        { currency: 'JPY', store_id: STORE_B, values: { net_sales_minor: 100000, orders: 12 } },
      ],
      labels: { store: { [STORE_A]: 'Brand A', [STORE_B]: 'Brand B' } },
    } as unknown as MetricResult;
  }
  if (body.dimensions.includes('product')) {
    return {
      ...totals(body.metrics, {}),
      rows: [
        {
          currency: 'JPY',
          product_id: PROD,
          values: { product_net_ex_tax_minor: 90000, units: 30 },
        },
        {
          currency: 'JPY',
          product_id: PROD_2,
          values: { product_net_ex_tax_minor: 1000, units: 1 },
        },
      ],
      labels: { product: { [PROD]: 'Linen tea towel', [PROD_2]: '(deleted)' } },
    } as unknown as MetricResult;
  }
  if (body.dimensions.length > 0) return { ...totals(body.metrics, {}), rows: [] } as MetricResult;
  return totals(body.metrics, VALUES, PREVIOUS);
}

async function show(element: Promise<ReactElement>) {
  return render(await element);
}

beforeEach(() => {
  vi.clearAllMocks();
  biApi.listMetrics.mockResolvedValue(ok(catalogue()));
  biApi.queryMetrics.mockImplementation((body: MetricQuery) => Promise.resolve(ok(answer(body))));
  v2Api.listMetricMovers.mockResolvedValue(ok(movers()));
  v2Api.getInventoryHealth.mockResolvedValue(ok(inventory()));
});

describe('Overview', () => {
  it('the headline: net sales first, in JPY with no decimals, with the change and the previous value', async () => {
    await show(OverviewView({ raw: RAW, base: '/bi' }));
    const cards = within(screen.getByRole('list', { name: 'Headline figures' })).getAllByRole(
      'listitem',
    );
    expect(cards[0]).toHaveAccessibleName('Net sales');
    expect(cards[0]).toHaveTextContent('JP¥300,000');
    expect(cards[0]).toHaveTextContent('+JP¥50,000 (+20 %) vs JP¥250,000');
    expect(screen.getByRole('listitem', { name: 'Orders' })).toHaveTextContent('42');
    // A ratio, not a percentage (#927 review): 21 429 bp = 2.14 items per order.
    const ipo = screen.getByRole('listitem', { name: 'Items per order' });
    expect(ipo).toHaveTextContent('2.14');
    expect(ipo).not.toHaveTextContent('214.3');
  });

  it('every figure carries its written definition from the catalogue', async () => {
    await show(OverviewView({ raw: RAW, base: '/bi' }));
    const card = screen.getByRole('listitem', { name: 'Net sales' });
    expect(within(card).getByText('How is this measured?')).toBeInTheDocument();
    expect(card).toHaveTextContent("Net sales: the catalogue's written definition.");
  });

  it('the headline is asked in queries of at most max_metrics, all compared', async () => {
    await show(OverviewView({ raw: RAW, base: '/bi' }));
    const headline = biApi.queryMetrics.mock.calls
      .map(([b]) => b as MetricQuery)
      .filter((b) => b.dimensions.length === 0);
    expect(headline.map((b) => b.metrics.length)).toEqual([6, 5]);
    expect(headline.every((b) => b.compare === 'previous_period')).toBe(true);
  });

  it('the breakdown names stores, filters the page on click, and drills to the store’s orders in the period', async () => {
    await show(OverviewView({ raw: RAW, base: '/bi' }));
    const table = screen.getByRole('table', { name: 'Breakdown by store' });
    expect(within(table).getByRole('link', { name: 'Filter by Brand A' })).toHaveAttribute(
      'href',
      `/bi/overview?from=2026-11-01&to=2026-11-15&store=${STORE_A}`,
    );
    expect(
      within(table).getByRole('link', { name: 'Orders of Brand A in this period' }),
    ).toHaveAttribute(
      'href',
      `/${STORE_A}/orders?placed_from=2026-11-01T00:00:00.000Z&placed_to=2026-11-14T23:59:59.999Z`,
    );
  });

  it('a breakdown that cannot drill down to orders says so', async () => {
    await show(OverviewView({ raw: { ...RAW, by: 'country' }, base: '/bi' }));
    expect(screen.getByText(/Drill-down to orders is per store only/)).toBeInTheDocument();
  });

  it('What changed: risers and fallers by name, change only', async () => {
    await show(OverviewView({ raw: RAW, base: '/bi' }));
    expect(screen.getByText('Biggest rises').parentElement).toHaveTextContent(
      'Brand A+JP¥80,000 (+66.7 %)',
    );
    expect(screen.getByText('Biggest falls').parentElement).toHaveTextContent(
      'Brand B−JP¥30,000 (−23.1 %)',
    );
    expect(screen.getByText(/never why/)).toBeInTheDocument();
  });

  it('an incomplete current period is said; no comparison means no movers call', async () => {
    biApi.queryMetrics.mockImplementation((body: MetricQuery) => {
      const result = answer(body);
      return Promise.resolve(
        ok(
          result.compare
            ? { ...result, compare: { ...result.compare, current_incomplete: true } }
            : result,
        ),
      );
    });
    await show(OverviewView({ raw: RAW, base: '/bi' }));
    expect(screen.getByText(/The current period has not ended yet/)).toBeInTheDocument();
    vi.clearAllMocks();
    biApi.listMetrics.mockResolvedValue(ok(catalogue()));
    biApi.queryMetrics.mockImplementation((body: MetricQuery) => Promise.resolve(ok(answer(body))));
    await show(OverviewView({ raw: { ...RAW, compare: 'none' }, base: '/bi' }));
    expect(v2Api.listMetricMovers).not.toHaveBeenCalled();
  });

  it('a 503 from the analytics store is its state panel, nothing partial', async () => {
    biApi.queryMetrics.mockResolvedValue({
      ok: false,
      status: 503,
      error: { code: 'unavailable', message: 'analytics store down' },
    });
    await show(OverviewView({ raw: RAW, base: '/bi' }));
    expect(screen.queryByRole('list', { name: 'Headline figures' })).not.toBeInTheDocument();
  });

  it('a store view is narrowed to its store and never broken down by store', async () => {
    await show(OverviewView({ raw: RAW, base: `/${STORE_A}/bi`, storeId: STORE_A }));
    const bodies = biApi.queryMetrics.mock.calls.map(([b]) => b as MetricQuery);
    expect(bodies.every((b) => b.filters?.store_ids?.[0] === STORE_A)).toBe(true);
    expect(bodies.some((b) => b.dimensions.includes('store'))).toBe(false);
  });
});

describe('Products & categories', () => {
  it('products by name — a deleted one says so — never by id', async () => {
    await show(ProductsView({ raw: RAW, base: '/bi' }));
    const best = screen.getAllByRole('table', { name: 'By product' })[0]!;
    expect(
      within(best).getByRole('link', { name: 'Filter by Linen tea towel' }),
    ).toBeInTheDocument();
    expect(within(best).getByText('(deleted)')).toBeInTheDocument();
    expect(best).not.toHaveTextContent(PROD);
  });

  it('stock but no sales comes from inventory health (status dead)', async () => {
    v2Api.getInventoryHealth.mockResolvedValue(
      ok(inventory({ rows: [{ ...inventory().rows[0]!, status: 'dead', last_sale_at: null }] })),
    );
    await show(ProductsView({ raw: RAW, base: '/bi' }));
    expect(v2Api.getInventoryHealth).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['dead'] }),
    );
    expect(screen.getByRole('table', { name: 'Stock but no sales' })).toHaveTextContent(
      'Tee M red TEE-M-RED8never60',
    );
  });

  it('when sales rates are unavailable, it says so instead of listing nothing', async () => {
    v2Api.getInventoryHealth.mockResolvedValue(ok(inventory({ rate_available: false })));
    await show(ProductsView({ raw: RAW, base: '/bi' }));
    expect(
      screen.getByText(
        /Sales rates are unavailable right now, so items without sales cannot be found/,
      ),
    ).toBeInTheDocument();
  });
});

describe('Inventory health', () => {
  it('per item: status, available vs reserved, cover, suggestion; shared pool and partial suggestion said', async () => {
    await show(InventoryView({ raw: {}, base: '/bi', canOpenLedger: false }));
    const row = within(screen.getByRole('table', { name: 'Inventory health' })).getAllByRole(
      'row',
    )[1]!;
    expect(row).toHaveTextContent('Tee M red');
    expect(row).toHaveTextContent('shared pool');
    expect(row).toHaveTextContent('Low — order now');
    expect(row).toHaveTextContent('may be understated');
    expect(row).toHaveTextContent(
      "80this store's sales only — HQ's view is authoritative for a shared pool",
    );
    expect(row).toHaveTextContent('wh-eu: available 8, reserved 4, on hand 12');
    expect(row).toHaveTextContent('lead 14 d, cover 30 d (the platform default)');
  });

  it('says incoming stock is not tracked yet', async () => {
    await show(InventoryView({ raw: {}, base: '/bi', canOpenLedger: false }));
    expect(screen.getByText(/Incoming stock is not tracked yet/)).toBeInTheDocument();
  });

  it('degraded: rates unavailable → positions live, cover and suggestions not computed', async () => {
    v2Api.getInventoryHealth.mockResolvedValue(
      ok(
        inventory({
          rate_available: false,
          rows: [
            {
              ...inventory().rows[0]!,
              status: null,
              days_of_cover: null,
              suggested_reorder_units: null,
              units_sold_per_day_milli: null,
            },
          ],
        }),
      ),
    );
    await show(InventoryView({ raw: {}, base: '/bi', canOpenLedger: false }));
    expect(
      screen.getByText(
        /Sales rates are unavailable right now \(the analytics store did not answer\)/,
      ),
    ).toBeInTheDocument();
    // Unknown is "not computed", never 0: the status, the rate, the cover, the suggestion and every chip.
    expect(screen.getAllByText('not computed').length).toBeGreaterThanOrEqual(4);
    const chips = screen.getByRole('list', { name: 'Items per status' });
    expect(within(chips).getAllByText('not computed')).toHaveLength(6);
    expect(screen.getByRole('status', { name: 'The answer' })).toHaveTextContent(
      'Cannot compute what to order right now',
    );
  });

  it('status chips count the whole filtered set and toggle the filter', async () => {
    await show(InventoryView({ raw: { status: 'low' }, base: '/bi', canOpenLedger: false }));
    const chips = screen.getByRole('list', { name: 'Items per status' });
    const low = within(chips).getByText('Low — order now').closest('a')!;
    expect(low).toHaveAttribute('aria-pressed', 'true');
    expect(low).toHaveTextContent('2');
    expect(within(chips).getByText('Reorder point reached').closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('status=low%2Creorder'),
    );
  });

  it('the ledger link appears only for who may open HQ · Warehouse', async () => {
    const { unmount } = await show(InventoryView({ raw: {}, base: '/bi', canOpenLedger: true }));
    expect(screen.getByRole('link', { name: 'Ledger of TEE-M-RED in wh-eu' })).toHaveAttribute(
      'href',
      `/warehouse?item=${ITEM}&view=movements&warehouse_id=${WH}`,
    );
    unmount();
    await show(InventoryView({ raw: {}, base: '/bi', canOpenLedger: false }));
    expect(screen.queryByRole('link', { name: /^Ledger of / })).not.toBeInTheDocument();
  });
});

describe('manager notes: the landing tab, the answer, the link', () => {
  it('Inventory health is the first view in the BI nav, with the plain answer on top', async () => {
    await show(InventoryView({ raw: {}, base: '/bi', canOpenLedger: false }));
    const links = within(screen.getByRole('navigation', { name: 'BI views' })).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Inventory health',
      'Overview',
      'Products & categories',
      'Dashboard',
    ]);
    expect(screen.getByRole('status', { name: 'The answer' })).toHaveTextContent(
      '6 items need ordering (1 out of stock, 2 low); incoming stock is not tracked yet.',
    );
  });

  it('"Copy link to this view" copies the URL, which holds every filter', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await show(OverviewView({ raw: RAW, base: '/bi' }));
    await user.click(screen.getByRole('button', { name: 'Copy link to this view' }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByText('Link copied: it opens this exact view.')).toBeInTheDocument();
  });
});
