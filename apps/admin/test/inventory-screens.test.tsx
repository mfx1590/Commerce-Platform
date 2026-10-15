/**
 * Store inventory (#468): rows keyed by (variant, warehouse) with the POOL's numbers — two variants
 * of two brands sharing one pool row render twice with the same numbers, never summed; the
 * "shared with N brands" badge only for principals that can read stock items (viewer on hq).
 * Also the orders table's payment status `voided` (#466).
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InventoryPage from '@/app/(store)/[storeId]/inventory/page';
import { InventoryTable } from '@/app/(store)/[storeId]/inventory/inventory-table';
import {
  PAYMENT_STATUSES,
  statusLabel,
  toneFor,
} from '@/app/(store)/[storeId]/orders/orders-table.config';
import { SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/inventory',
}));
vi.mock('@/components/shell/section-guard', () => ({
  StoreSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));
const api = vi.hoisted(() => ({
  listInventoryLevels: vi.fn(),
  listStockItems: vi.fn(),
  listWarehouses: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const POOL_ROW = '70000000-0000-4000-8000-000000000001';
const ITEM = '71000000-0000-4000-8000-000000000001';
const WAREHOUSE = '00000000-0000-4000-8000-000000000021';
const numbers = { on_hand: 40, reserved: 3, incoming: 5, available: 37 };
// One pool row, two variants of two brands (as an HQ principal's response carries them).
const shared = [
  {
    id: POOL_ROW,
    store_id: SEED.stores.brandA,
    variant_id: '30000000-0000-4000-8000-000000000301',
    stock_item_id: ITEM,
    sku: 'A-TEE-M-RED',
    warehouse_id: WAREHOUSE,
    warehouse_code: 'wh-eu',
    ...numbers,
  },
  {
    id: POOL_ROW,
    store_id: SEED.stores.brandB,
    variant_id: '30000000-0000-4000-8000-000000000302',
    stock_item_id: ITEM,
    sku: 'B-TEE-M-RED',
    warehouse_id: WAREHOUSE,
    warehouse_code: 'wh-eu',
    ...numbers,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.listInventoryLevels.mockResolvedValue(ok({ items: shared, page: 1, limit: 50, total: 2 }));
  api.listWarehouses.mockResolvedValue(
    ok({
      items: [
        {
          id: WAREHOUSE,
          code: 'main',
          name: 'Main DC',
          country: 'DE',
          is_active: true,
          priority: 1,
        },
      ],
    }),
  );
  api.listStockItems.mockResolvedValue(
    ok({
      items: [
        {
          id: ITEM,
          sku: 'TEE-M-RED',
          name: 'Tee',
          barcode: null,
          variants: [
            { variant_id: shared[0]!.variant_id, store_id: SEED.stores.brandA, sku: 'A-TEE-M-RED' },
            { variant_id: shared[1]!.variant_id, store_id: SEED.stores.brandB, sku: 'B-TEE-M-RED' },
          ],
          levels: [{ warehouse_id: WAREHOUSE, ...numbers }],
        },
      ],
      page: 1,
      limit: 100,
      total: 1,
    }),
  );
});

describe('InventoryTable', () => {
  it('two variants of two brands sharing one pool row render as two rows with the same numbers, no sum', () => {
    render(
      <InventoryTable
        rows={shared}
        warehouseNames={{ [WAREHOUSE]: 'Main DC' }}
        sharedBrands={{ [ITEM]: 2 }}
      />,
    );
    const table = screen.getByRole('table', { name: 'Inventory levels' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-row-key'))).toEqual([
      `${shared[0]!.variant_id}:${WAREHOUSE}`,
      `${shared[1]!.variant_id}:${WAREHOUSE}`,
    ]);
    for (const row of rows) {
      const cells = within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
      expect(cells.slice(3)).toEqual(['40', '3', '5', '37']);
      expect(within(row).getByText('Shared with 2 brands')).toBeInTheDocument();
    }
    // Nothing on screen is the sum of the two rows.
    expect(table).not.toHaveTextContent('80');
    expect(table).not.toHaveTextContent('74');
  });

  it('no badge when the principal cannot read stock items', () => {
    render(<InventoryTable rows={shared} warehouseNames={{}} sharedBrands={null} />);
    expect(screen.queryByText(/Shared with/)).toBeNull();
    expect(screen.getAllByText(ITEM.slice(0, 8))).toHaveLength(2);
  });
});

describe('the inventory page', () => {
  async function renderPage(search: Record<string, string> = {}) {
    render(
      await InventoryPage({
        params: Promise.resolve({ storeId: SEED.stores.brandA }),
        searchParams: Promise.resolve(search),
      }),
    );
  }

  it('a store admin sees the stock item id and never calls the hq reads (listStockItems, listWarehouses)', async () => {
    await renderPage();
    expect(api.listStockItems).not.toHaveBeenCalled();
    expect(api.listWarehouses).not.toHaveBeenCalled();
    expect(screen.queryByText(/Shared with/)).toBeNull();
    const table = screen.getByRole('table', { name: 'Inventory levels' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    // No read names the warehouse for a store principal: a short id, and the filter offers it.
    expect(within(table).getAllByText('Warehouse 00000000')).toHaveLength(2);
    expect(
      within(screen.getByLabelText('Warehouse')).getByRole('option', {
        name: 'Warehouse 00000000',
      }),
    ).toHaveValue(WAREHOUSE);
  });

  it('an HQ principal gets the warehouse names', async () => {
    principalOf.current = 'operations';
    await renderPage();
    expect(api.listWarehouses).toHaveBeenCalled();
    const table = screen.getByRole('table', { name: 'Inventory levels' });
    expect(within(table).getAllByText('Main DC')).toHaveLength(2);
    expect(screen.getByRole('option', { name: 'Main DC' })).toHaveValue(WAREHOUSE);
  });

  it('an HQ principal gets the shared badge (listStockItems for this store, shared only)', async () => {
    principalOf.current = 'operations';
    await renderPage();
    expect(api.listStockItems).toHaveBeenCalledWith({
      store_id: SEED.stores.brandA,
      shared: 'true',
      limit: 100,
    });
    expect(screen.getAllByText('Shared with 2 brands')).toHaveLength(2);
  });

  it('passes store, filters and sort to listInventoryLevels', async () => {
    await renderPage({
      sku: 'TEE',
      warehouse_id: WAREHOUSE,
      below_available: '5',
      sort: 'available',
    });
    expect(api.listInventoryLevels).toHaveBeenCalledWith({
      store_id: SEED.stores.brandA,
      sku: 'TEE',
      warehouse_id: WAREHOUSE,
      below_available: '5',
      sort: 'available',
      page: 1,
      limit: 50,
    });
  });

  it('a 403 renders the refusal panel', async () => {
    api.listInventoryLevels.mockResolvedValue({
      ok: false,
      status: 403,
      error: {
        code: 'forbidden',
        message: 'requires viewer',
        details: { relation: 'viewer', object: `store:${SEED.stores.brandA}` },
      },
    });
    await renderPage();
    expect(screen.queryByRole('table', { name: 'Inventory levels' })).toBeNull();
    expect(document.body).toHaveTextContent(/viewer/);
  });
});

describe('orders: payment status voided', () => {
  it('is in the filter list, labelled "voided" like every status, in a neutral tone', () => {
    expect(PAYMENT_STATUSES).toContain('voided');
    expect(statusLabel('voided')).toBe('voided');
    expect(toneFor('voided')).toBe('neutral');
  });
});
