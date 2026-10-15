/**
 * HQ warehouse screens (#468): stock items with the pool action, cycle counts with record,
 * reconcile and approve — every error from window 11's brief rendered — and the guard that keeps a
 * store admin out.
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WarehousePage from '@/app/(hq)/warehouse/page';
import {
  ApproveButton,
  PoolVariantForm,
  ReconcileButton,
  RecordCountForm,
} from '@/app/(hq)/warehouse/warehouse-forms';
import { describeCycleCountError, describeMapError } from '@/lib/warehouse';
import { SEED, type PrincipalKey } from './fixtures/principals';
import type * as SectionGuard from '@/components/shell/section-guard';

vi.mock('server-only', () => ({}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/warehouse',
}));
const actions = vi.hoisted(() => ({
  mapVariantAction: vi.fn(),
  recordCycleCountAction: vi.fn(),
  reconcileCycleCountAction: vi.fn(),
}));
vi.mock('@/app/actions/warehouse', () => actions);
vi.mock('@/components/shell/section-guard', () => ({
  HqSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
const principalOf = vi.hoisted(() => ({ current: 'operations' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));
const api = vi.hoisted(() => ({
  listStores: vi.fn(),
  listWarehouses: vi.fn(),
  listStockItems: vi.fn(),
  listCycleCounts: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const err = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});
const asActionError = (errors: {
  fieldErrors: Record<string, string>;
  formError: string | null;
}) => ({
  status: 'error' as const,
  ...errors,
});

const ITEM = '71000000-0000-4000-8000-000000000001';
const ITEM_B = '71000000-0000-4000-8000-000000000002';
const WAREHOUSE = '00000000-0000-4000-8000-000000000021';
const VARIANT_A = '30000000-0000-4000-8000-000000000301';
const VARIANT_B = '30000000-0000-4000-8000-000000000302';
const VARIANT_C = '30000000-0000-4000-8000-000000000303';

const pooled = {
  id: ITEM,
  sku: 'TEE-M-RED',
  name: 'Tee M red',
  barcode: null,
  variants: [
    { variant_id: VARIANT_A, store_id: SEED.stores.brandA, sku: 'A-TEE-M-RED' },
    { variant_id: VARIANT_B, store_id: SEED.stores.brandB, sku: 'B-TEE-M-RED' },
  ],
  levels: [{ warehouse_id: WAREHOUSE, on_hand: 40, reserved: 3, incoming: 0, available: 37 }],
};
const single = {
  id: ITEM_B,
  sku: 'CAP-BLUE',
  name: 'Cap blue',
  barcode: null,
  variants: [{ variant_id: VARIANT_C, store_id: SEED.stores.brandB, sku: 'B-CAP-BLUE' }],
  levels: [],
};

const baseCount = {
  warehouse_id: WAREHOUSE,
  stock_item_id: ITEM,
  sku: 'TEE-M-RED',
  counted_quantity: 38,
  counted_by: '00000000-0000-4000-8000-000000000043',
  source: 'manual',
  note: null,
  on_hand_as_of_count: null,
  delta: null,
  stock_movement_id: null,
  approved_by: null,
  approved_at: null,
  reconciled_at: null,
};
const counts = [
  {
    ...baseCount,
    id: '72000000-0000-4000-8000-000000000003',
    counted_at: '2026-10-14T08:00:00Z',
    status: 'flagged',
    on_hand_as_of_count: 40,
    delta: -2,
  },
  {
    ...baseCount,
    id: '72000000-0000-4000-8000-000000000002',
    counted_at: '2026-10-13T08:00:00Z',
    status: 'recorded',
    counted_by: null,
    source: 'wms',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'operations';
  api.listStores.mockResolvedValue(
    ok({
      items: [
        { id: SEED.stores.brandA, code: 'brand-a', name: 'Brand A' },
        { id: SEED.stores.brandB, code: 'brand-b', name: 'Brand B' },
      ],
      page: 1,
      limit: 100,
      total: 2,
    }),
  );
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
    ok({ items: [pooled, single], page: 1, limit: 25, total: 2 }),
  );
  api.listCycleCounts.mockResolvedValue(ok({ items: counts, page: 1, limit: 25, total: 2 }));
});

async function renderPage(search: Record<string, string> = {}) {
  render(await WarehousePage({ searchParams: Promise.resolve(search) }));
}

describe('the warehouse section guard', () => {
  it.each(['storeAdmin', 'storeStaff', 'finance'] as const)(
    '%s gets the 403 panel naming operations on hq',
    async (role) => {
      principalOf.current = role;
      const { HqSectionGuard } = await vi.importActual<typeof SectionGuard>(
        '@/components/shell/section-guard',
      );
      render(await HqSectionGuard({ id: 'warehouse', children: <p>the warehouse screen</p> }));
      expect(screen.queryByText('the warehouse screen')).toBeNull();
      expect(document.body).toHaveTextContent(/operations relation on organization:hq/);
    },
  );

  it.each(['operations', 'owner'] as const)('%s passes the real guard', async (role) => {
    principalOf.current = role;
    const { HqSectionGuard } = await vi.importActual<typeof SectionGuard>(
      '@/components/shell/section-guard',
    );
    render(await HqSectionGuard({ id: 'warehouse', children: <p>the warehouse screen</p> }));
    expect(screen.getByText('the warehouse screen')).toBeInTheDocument();
  });
});

describe('stock items', () => {
  it('lists each item with its variants per brand, the pool level per warehouse, and the shared badge', async () => {
    await renderPage();
    const item = screen.getByRole('listitem', { name: 'Stock item TEE-M-RED' });
    expect(within(item).getByText('Shared with 2 brands')).toBeInTheDocument();
    const variants = within(item).getByRole('table', { name: 'Variants mapping TEE-M-RED' });
    expect(within(variants).getByText('Brand A')).toBeInTheDocument();
    expect(within(variants).getByText('B-TEE-M-RED')).toBeInTheDocument();
    const levels = within(item).getByRole('table', { name: 'Pool levels of TEE-M-RED' });
    expect(within(levels).getByText('Main DC')).toBeInTheDocument();
    expect(within(levels).getByText('37')).toBeInTheDocument();
    const lone = screen.getByRole('listitem', { name: 'Stock item CAP-BLUE' });
    expect(within(lone).queryByText(/Shared with/)).toBeNull();
    expect(within(lone).getByText('Not stocked in any warehouse.')).toBeInTheDocument();
  });

  it('passes the filters to listStockItems', async () => {
    await renderPage({ sku: 'TEE', store_id: SEED.stores.brandA, shared: 'true', page: '2' });
    expect(api.listStockItems).toHaveBeenCalledWith({
      sku: 'TEE',
      store_id: SEED.stores.brandA,
      shared: 'true',
      page: 2,
      limit: 25,
    });
  });

  it('a non-uuid store filter is dropped', async () => {
    await renderPage({ store_id: 'nope' });
    expect(api.listStockItems).toHaveBeenCalledWith({ page: 1, limit: 25 });
  });

  it('operations is offered the pool action; analyst only reads', async () => {
    await renderPage();
    expect(screen.getAllByRole('button', { name: /Pool a variant onto/ })).toHaveLength(2);
    vi.clearAllMocks();
    document.body.innerHTML = '';
    principalOf.current = 'analyst';
    api.listStores.mockResolvedValue(ok({ items: [], page: 1, limit: 100, total: 0 }));
    api.listWarehouses.mockResolvedValue(ok({ items: [] }));
    api.listStockItems.mockResolvedValue(ok({ items: [pooled], page: 1, limit: 25, total: 1 }));
    await renderPage();
    expect(screen.queryByRole('button', { name: /Pool a variant onto/ })).toBeNull();
  });

  it('a 403 from listStockItems renders the refusal panel', async () => {
    api.listStockItems.mockResolvedValue({
      ok: false,
      ...err(403, 'forbidden', 'requires viewer on organization:hq', {
        relation: 'viewer',
        object: 'organization:hq',
      }),
    });
    await renderPage();
    expect(screen.queryByRole('list', { name: 'Stock items' })).toBeNull();
    expect(document.body).toHaveTextContent(/organization:hq/);
  });
});

describe('PoolVariantForm', () => {
  const choices = [{ variantId: VARIANT_C, sku: 'B-CAP-BLUE', storeLabel: 'Brand B' }];

  async function openAndAsk() {
    const user = userEvent.setup();
    render(
      <PoolVariantForm
        stockItemId={ITEM}
        itemSku="TEE-M-RED"
        itemBrands={['Brand A']}
        choices={choices}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Pool a variant onto TEE-M-RED' }));
    await user.click(screen.getByRole('button', { name: 'Pool…' }));
    return user;
  }

  it('asks first, naming both brands', async () => {
    await openAndAsk();
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm pooling onto TEE-M-RED' });
    expect(dialog).toHaveTextContent(
      /Pool B-CAP-BLUE of Brand B onto TEE-M-RED \(mapped by Brand A\)/,
    );
    expect(dialog).toHaveTextContent(/Brand B sells from this item’s shelf, shared with Brand A/);
    expect(actions.mapVariantAction).not.toHaveBeenCalled();
  });

  it('confirming pools the variant and refreshes', async () => {
    actions.mapVariantAction.mockResolvedValue({ status: 'success', data: pooled });
    const user = await openAndAsk();
    await user.click(screen.getByRole('button', { name: 'Yes, pool it' }));
    expect(actions.mapVariantAction).toHaveBeenCalledWith(ITEM, VARIANT_C);
    expect(await screen.findByRole('status')).toHaveTextContent(/now sells from TEE-M-RED/);
    expect(refresh).toHaveBeenCalled();
  });

  it('409: the old item still holds stock — said in words', async () => {
    actions.mapVariantAction.mockResolvedValue(
      asActionError(
        describeMapError(
          err(409, 'conflict', 'holds stock', {
            stock_item_id: ITEM_B,
            on_hand: 4,
            open_reservations: 0,
          }),
        ),
      ),
    );
    const user = await openAndAsk();
    await user.click(screen.getByRole('button', { name: 'Yes, pool it' }));
    expect(
      await screen.findByText(
        /still holds stock or open reservations \(4 on hand, 0 open reservations\) — move the stock first/,
      ),
    ).toBeInTheDocument();
  });

  it('404: unknown item or variant', async () => {
    actions.mapVariantAction.mockResolvedValue(
      asActionError(describeMapError(err(404, 'not_found', 'not found'))),
    );
    const user = await openAndAsk();
    await user.click(screen.getByRole('button', { name: 'Yes, pool it' }));
    expect(
      await screen.findByText('That stock item or variant was not found.'),
    ).toBeInTheDocument();
  });

  it('a typed id that is not a uuid never reaches the action', async () => {
    const user = userEvent.setup();
    render(<PoolVariantForm stockItemId={ITEM} itemSku="TEE-M-RED" itemBrands={[]} choices={[]} />);
    await user.click(screen.getByRole('button', { name: 'Pool a variant onto TEE-M-RED' }));
    await user.type(screen.getByLabelText('Variant id'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Pool…' }));
    expect(screen.getByText('Enter a variant id (uuid).')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('cycle counts', () => {
  it('lists counts newest first with the advice, WMS counts, older-count tag and the right action per status', async () => {
    await renderPage({ tab: 'counts' });
    expect(screen.getByRole('note')).toHaveTextContent(/reconcile the newest/);
    const table = screen.getByRole('table', { name: 'Cycle counts' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/flagged/);
    expect(rows[0]).toHaveTextContent('−2');
    expect(
      within(rows[0]!).getByRole('button', { name: 'Approve the count of TEE-M-RED' }),
    ).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('WMS');
    expect(within(rows[1]!).getByText('older count')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByRole('button', { name: 'Reconcile the count of TEE-M-RED' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Record a count' })).toBeInTheDocument();
  });

  it('passes the filters to listCycleCounts', async () => {
    await renderPage({
      tab: 'counts',
      warehouse_id: WAREHOUSE,
      stock_item_id: ITEM,
      status: 'flagged',
    });
    expect(api.listCycleCounts).toHaveBeenCalledWith({
      warehouse_id: WAREHOUSE,
      stock_item_id: ITEM,
      status: 'flagged',
      page: 1,
      limit: 25,
    });
  });

  it('an unknown status filter is dropped', async () => {
    await renderPage({ tab: 'counts', status: 'bogus' });
    expect(api.listCycleCounts).toHaveBeenCalledWith({ page: 1, limit: 25 });
  });
});

describe('ReconcileButton renders every error from the brief', () => {
  const cases: Array<[string, ReturnType<typeof err>, RegExp]> = [
    [
      '409 superseded — a newer count applied',
      err(409, 'conflict', 'superseded', {
        reason: 'superseded',
        applied_cycle_count_id: '72000000-0000-4000-8000-000000000009',
      }),
      /A newer count of this shelf is already applied.*can never be applied; it stays as a record/,
    ],
    [
      '409 superseded — a hand correction after the count',
      err(409, 'conflict', 'superseded', {
        reason: 'superseded',
        stock_movement_id: '73000000-0000-4000-8000-000000000009',
      }),
      /The stock was corrected by hand after this count/,
    ],
    [
      '409 negative on-hand',
      err(409, 'conflict', 'on hand would go negative'),
      /would take on-hand below zero.*Count the shelf again/,
    ],
    ['404', err(404, 'not_found', 'not found'), /warehouse has been deactivated/],
    ['400', err(400, 'validation_error', 'malformed body'), /not accepted: malformed body/],
  ];

  it.each(cases)('%s', async (_name, failure, words) => {
    actions.reconcileCycleCountAction.mockResolvedValue(
      asActionError(describeCycleCountError(failure)),
    );
    const user = userEvent.setup();
    render(<ReconcileButton cycleCountId={counts[1]!.id} sku="TEE-M-RED" />);
    await user.click(screen.getByRole('button', { name: 'Reconcile the count of TEE-M-RED' }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(actions.reconcileCycleCountAction).toHaveBeenCalledWith(counts[1]!.id, false);
  });

  it('applied and flagged outcomes are said', async () => {
    const user = userEvent.setup();
    actions.reconcileCycleCountAction.mockResolvedValueOnce({
      status: 'success',
      data: { ...counts[1], status: 'applied', delta: -2 },
    });
    render(<ReconcileButton cycleCountId={counts[1]!.id} sku="TEE-M-RED" />);
    await user.click(screen.getByRole('button', { name: 'Reconcile the count of TEE-M-RED' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Applied — one movement of −2.');

    actions.reconcileCycleCountAction.mockResolvedValueOnce({
      status: 'success',
      data: { ...counts[1], status: 'flagged', delta: 7 },
    });
    await user.click(screen.getByRole('button', { name: 'Reconcile the count of TEE-M-RED' }));
    expect(
      await screen.findByText(/Flagged — the discrepancy \(\+7\) is above the tolerance/),
    ).toBeInTheDocument();
  });
});

describe('ApproveButton', () => {
  it('shows the flag’s delta with the recompute warning before confirming, then the applied delta', async () => {
    actions.reconcileCycleCountAction.mockResolvedValue({
      status: 'success',
      data: { ...counts[0], status: 'applied', delta: -3 },
    });
    const user = userEvent.setup();
    render(
      <ApproveButton
        cycleCountId={counts[0]!.id}
        sku="TEE-M-RED"
        flaggedDelta={-2}
        onHandNow={39}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Approve the count of TEE-M-RED' }));
    const dialog = screen.getByRole('alertdialog', {
      name: 'Confirm approving the count of TEE-M-RED',
    });
    expect(dialog).toHaveTextContent(
      'Delta when flagged: −2 — recomputed on approval; may differ.',
    );
    expect(dialog).toHaveTextContent('On hand now: 39.');
    expect(actions.reconcileCycleCountAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, approve' }));
    expect(actions.reconcileCycleCountAction).toHaveBeenCalledWith(counts[0]!.id, true);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Approved — applied −3 (changed since the flag).',
    );
  });

  it('a 409 superseded at approval is said', async () => {
    actions.reconcileCycleCountAction.mockResolvedValue(
      asActionError(
        describeCycleCountError(
          err(409, 'conflict', 'superseded', {
            reason: 'superseded',
            applied_cycle_count_id: '72000000-0000-4000-8000-000000000009',
          }),
        ),
      ),
    );
    const user = userEvent.setup();
    render(
      <ApproveButton
        cycleCountId={counts[0]!.id}
        sku="TEE-M-RED"
        flaggedDelta={-2}
        onHandNow={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Approve the count of TEE-M-RED' }));
    await user.click(screen.getByRole('button', { name: 'Yes, approve' }));
    expect(
      await screen.findByText(/newer count of this shelf is already applied/),
    ).toBeInTheDocument();
  });
});

describe('RecordCountForm', () => {
  const warehouses = [{ value: WAREHOUSE, label: 'Main DC' }];
  const items = [{ value: ITEM, label: 'TEE-M-RED — Tee M red' }];

  it('records a count and says no stock changed yet', async () => {
    actions.recordCycleCountAction.mockResolvedValue({
      status: 'success',
      data: { ...counts[1], status: 'recorded' },
    });
    const user = userEvent.setup();
    render(<RecordCountForm warehouses={warehouses} stockItems={items} />);
    await user.type(screen.getByLabelText('Counted quantity'), '38');
    await user.click(screen.getByRole('button', { name: 'Record count' }));
    expect(actions.recordCycleCountAction).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouse_id: WAREHOUSE,
        stock_item_id: ITEM,
        counted_quantity: '38',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/No stock changed yet/);
  });

  it('422 counted_at in the future lands under the field', async () => {
    actions.recordCycleCountAction.mockResolvedValue(
      asActionError(
        describeCycleCountError(
          err(422, 'validation_error', 'counted_at may not be in the future', {
            field: 'counted_at',
          }),
          ['counted_at'],
        ),
      ),
    );
    const user = userEvent.setup();
    render(<RecordCountForm warehouses={warehouses} stockItems={items} />);
    await user.type(screen.getByLabelText('Counted quantity'), '5');
    await user.click(screen.getByRole('button', { name: 'Record count' }));
    expect(await screen.findByText('The count’s time is in the future.')).toBeInTheDocument();
  });

  it('a negative count never reaches the action', async () => {
    const user = userEvent.setup();
    render(<RecordCountForm warehouses={warehouses} stockItems={items} />);
    await user.type(screen.getByLabelText('Counted quantity'), '-1');
    await user.click(screen.getByRole('button', { name: 'Record count' }));
    expect(screen.getByText(/Enter the number counted/)).toBeInTheDocument();
    expect(actions.recordCycleCountAction).not.toHaveBeenCalled();
  });

  it('a server 403 renders the refusal panel', async () => {
    actions.recordCycleCountAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'You need the operations relation on organization:hq to save this.',
      refusal: err(403, 'forbidden', 'requires operations on organization:hq', {
        relation: 'operations',
        object: 'organization:hq',
      }),
    });
    const user = userEvent.setup();
    render(<RecordCountForm warehouses={warehouses} stockItems={items} />);
    await user.type(screen.getByLabelText('Counted quantity'), '5');
    await user.click(screen.getByRole('button', { name: 'Record count' }));
    expect(await screen.findByText(/operations/)).toBeInTheDocument();
  });
});
