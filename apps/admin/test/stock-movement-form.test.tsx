/**
 * The "Move stock" form (#870 wave 1 item 1): now and after numbers, the live refusal below zero
 * or below reserved, the payload per movement, the ledger opened on success, and the Store ·
 * Inventory "Ledger" link (only for a principal the warehouse section lets in).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StockMovementForm } from '@/app/(hq)/warehouse/warehouse-forms';
import { InventoryTable } from '@/app/(store)/[storeId]/inventory/inventory-table';

vi.mock('server-only', () => ({}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/warehouse',
}));
const actions = vi.hoisted(() => ({
  moveStockAction: vi.fn(),
  mapVariantAction: vi.fn(),
  recordCycleCountAction: vi.fn(),
  reconcileCycleCountAction: vi.fn(),
  previewCycleCountAction: vi.fn(),
}));
vi.mock('@/app/actions/warehouse', () => actions);

const ITEM = '71000000-0000-4000-8000-000000000001';
const MAIN = '00000000-0000-4000-8000-000000000021';
const SPARE = '00000000-0000-4000-8000-000000000022';
const warehouses = [
  { value: MAIN, label: 'Main DC' },
  { value: SPARE, label: 'Spare DC' },
];
const levels = [
  { warehouse_id: MAIN, on_hand: 10, reserved: 8, available: 2 },
  { warehouse_id: SPARE, on_hand: 4, reserved: 0, available: 4 },
];

function open() {
  const user = userEvent.setup();
  render(
    <StockMovementForm
      stockItemId={ITEM}
      sku="TEE-M-RED"
      levels={levels}
      warehouses={warehouses}
      listQuery="sku=TEE&page=2"
    />,
  );
  return user;
}

async function openForm() {
  const user = open();
  await user.click(screen.getByRole('button', { name: 'Move stock of TEE-M-RED' }));
  return { user, form: screen.getByRole('form', { name: 'Move stock of TEE-M-RED' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StockMovementForm', () => {
  it('shows the shelf now, and after as the change is typed', async () => {
    const { user, form } = await openForm();
    const numbers = within(form).getByLabelText('Stock before and after');
    expect(numbers).toHaveTextContent('Now: on hand 10 · reserved 8 · available 2');
    await user.type(within(form).getByLabelText('Change (e.g. -3 or 5)'), '5');
    expect(numbers).toHaveTextContent('After: on hand 15 · reserved 8 · available 7');
  });

  it('refuses below reserved before any request, and says how much can go', async () => {
    const { user, form } = await openForm();
    await user.type(within(form).getByLabelText('Change (e.g. -3 or 5)'), '-3');
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'fewer than the 8 reserved for open orders. At most 2 can go.',
    );
    expect(within(form).getByRole('button', { name: 'Adjust' })).toBeDisabled();
    expect(actions.moveStockAction).not.toHaveBeenCalled();
  });

  it('a 0 change is said under the field, not sent', async () => {
    const { user, form } = await openForm();
    await user.type(within(form).getByLabelText('Change (e.g. -3 or 5)'), '0');
    await user.click(within(form).getByRole('button', { name: 'Adjust' }));
    expect(within(form).getByText(/not 0/)).toBeInTheDocument();
    expect(actions.moveStockAction).not.toHaveBeenCalled();
  });

  it('receive: sends the payload, says the result and opens the ledger, filters kept', async () => {
    actions.moveStockAction.mockResolvedValue({
      status: 'success',
      data: {
        kind: 'receive',
        stockItemId: ITEM,
        warehouseId: SPARE,
        message: 'Received 6 of TEE-M-RED.',
        after: { on_hand: 10, reserved: 0, available: 10 },
      },
    });
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('Movement'), 'receive');
    await user.selectOptions(within(form).getByLabelText('Warehouse'), SPARE);
    await user.type(within(form).getByLabelText('Quantity'), '6');
    await user.type(within(form).getByLabelText(/^Note/), 'pallet 14');
    await user.click(within(form).getByRole('button', { name: 'Receive' }));
    expect(actions.moveStockAction).toHaveBeenCalledWith({
      kind: 'receive',
      stock_item_id: ITEM,
      sku: 'TEE-M-RED',
      warehouse_id: SPARE,
      quantity: '6',
      note: 'pallet 14',
    });
    expect(await within(form).findByRole('status')).toHaveTextContent(
      'Received 6 of TEE-M-RED. Spare DC now: on hand 10, reserved 0, available 10.',
    );
    const url = new URL(router.push.mock.calls[0]?.[0] as string, 'http://admin.test');
    expect(url.pathname).toBe('/warehouse');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sku: 'TEE',
      page: '2',
      item: ITEM,
      view: 'movements',
      warehouse_id: SPARE,
    });
  });

  it('transfer: both shelves now and after, then from → to in the payload', async () => {
    actions.moveStockAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: null,
    });
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('Movement'), 'transfer');
    await user.selectOptions(within(form).getByLabelText('From warehouse'), SPARE);
    await user.selectOptions(within(form).getByLabelText('To warehouse'), MAIN);
    await user.type(within(form).getByLabelText('Quantity'), '3');
    const numbers = within(form).getByLabelText('Stock before and after');
    expect(numbers).toHaveTextContent('Spare DC after: on hand 1 · reserved 0 · available 1');
    expect(numbers).toHaveTextContent('Main DC after: on hand 13 · reserved 8 · available 5');
    expect(numbers).toHaveTextContent('Two movements');
    await user.click(within(form).getByRole('button', { name: 'Transfer' }));
    expect(actions.moveStockAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'transfer',
        from_warehouse_id: SPARE,
        to_warehouse_id: MAIN,
        quantity: '3',
      }),
    );
  });

  it('transfer to the same warehouse is refused before any request', async () => {
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('Movement'), 'transfer');
    await user.selectOptions(within(form).getByLabelText('From warehouse'), MAIN);
    await user.selectOptions(within(form).getByLabelText('To warehouse'), MAIN);
    expect(within(form).getByText('Choose a different warehouse to move to.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Transfer' })).toBeDisabled();
  });

  it('the server’s refusal is shown in its words, and no ledger opens', async () => {
    actions.moveStockAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError:
        'The transfer was refused at the destination (Not found). The 3 units were put back in the source warehouse; nothing moved overall.',
    });
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('Movement'), 'transfer');
    await user.selectOptions(within(form).getByLabelText('From warehouse'), SPARE);
    await user.selectOptions(within(form).getByLabelText('To warehouse'), MAIN);
    await user.type(within(form).getByLabelText('Quantity'), '3');
    await user.click(within(form).getByRole('button', { name: 'Transfer' }));
    expect(await within(form).findByText(/put back in the source warehouse/)).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('Store · Inventory links each row to its ledger', () => {
  const row = {
    id: '70000000-0000-4000-8000-000000000001',
    store_id: '00000000-0000-4000-8000-000000000031',
    variant_id: '30000000-0000-4000-8000-000000000301',
    stock_item_id: ITEM,
    sku: 'TEE-M-RED',
    warehouse_id: MAIN,
    warehouse_code: 'wh-eu',
    on_hand: 10,
    reserved: 8,
    incoming: 0,
    available: 2,
  };

  it('for a principal the warehouse section lets in', () => {
    render(
      <InventoryTable
        rows={[row]}
        warehouseNames={{ [MAIN]: 'Main DC' }}
        sharedBrands={null}
        ledgerLinks
      />,
    );
    expect(screen.getByRole('link', { name: 'Ledger of TEE-M-RED in Main DC' })).toHaveAttribute(
      'href',
      `/warehouse?item=${ITEM}&view=movements&warehouse_id=${MAIN}`,
    );
  });

  it('not for anyone else (the link would end on a refusal)', () => {
    render(<InventoryTable rows={[row]} warehouseNames={{}} sharedBrands={null} />);
    expect(screen.queryByRole('link', { name: /Ledger/ })).not.toBeInTheDocument();
  });
});

describe('#879 review: large moves, the bound, and a single request', () => {
  it('above 100 units asks once more, showing the shelf after; Yes sends it', async () => {
    actions.moveStockAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: null,
    });
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('Movement'), 'receive');
    await user.type(within(form).getByLabelText('Quantity'), '150');
    await user.click(within(form).getByRole('button', { name: 'Receive' }));
    const dialog = within(form).getByRole('alertdialog', {
      name: 'Confirm moving 150 of TEE-M-RED',
    });
    expect(dialog).toHaveTextContent('Main DC after: on hand 160 · reserved 8 · available 152');
    expect(actions.moveStockAction).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, move 150' }));
    expect(actions.moveStockAction).toHaveBeenCalledTimes(1);
  });

  it('changing the amount drops the confirmation; 100 or fewer never asks', async () => {
    actions.moveStockAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: null,
    });
    const { user, form } = await openForm();
    const change = within(form).getByLabelText('Change (e.g. -3 or 5)');
    await user.type(change, '500');
    await user.click(within(form).getByRole('button', { name: 'Adjust' }));
    expect(within(form).getByRole('alertdialog')).toBeInTheDocument();
    await user.clear(change);
    await user.type(change, '100');
    expect(within(form).queryByRole('alertdialog')).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Adjust' }));
    expect(actions.moveStockAction).toHaveBeenCalledTimes(1);
  });

  it('more than 100,000 units is refused under the field, not sent', async () => {
    const { user, form } = await openForm();
    await user.type(within(form).getByLabelText('Change (e.g. -3 or 5)'), '100001');
    await user.click(within(form).getByRole('button', { name: 'Adjust' }));
    expect(within(form).getByText('At most 100,000 units per movement.')).toBeInTheDocument();
    expect(actions.moveStockAction).not.toHaveBeenCalled();
  });

  it('a second submit while the first is pending sends nothing', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    actions.moveStockAction.mockImplementation(() => new Promise((r) => (resolve = r)));
    const { user, form } = await openForm();
    await user.type(within(form).getByLabelText('Change (e.g. -3 or 5)'), '2');
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(within(form).getByRole('button', { name: 'Moving…' })).toBeDisabled(),
    );
    fireEvent.submit(form);
    expect(actions.moveStockAction).toHaveBeenCalledTimes(1);
    resolve({ status: 'error', fieldErrors: {}, formError: null });
  });
});
