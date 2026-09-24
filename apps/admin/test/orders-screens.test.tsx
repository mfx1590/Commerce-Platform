import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LineItemsPanel } from '@/app/(store)/[storeId]/orders/[orderId]/line-items-panel';
import { OrderActions } from '@/app/(store)/[storeId]/orders/[orderId]/order-actions';
import { FulfilmentPanel } from '@/app/(store)/[storeId]/orders/[orderId]/shipments-panel';
import { Timeline } from '@/app/(store)/[storeId]/orders/[orderId]/timeline';
import { OrdersTable } from '@/app/(store)/[storeId]/orders/orders-table';
import { ORDERS_TABLE_DEFAULTS } from '@/app/(store)/[storeId]/orders/orders-table.config';
import type { ActionResult } from '@/lib/forms/action-result';
import type { OrderPermissions } from '@/lib/orders/permissions';
import { DEFAULT_LIMIT, type TableQuery } from '@/lib/table/query-state';
import { IDS, line, order, ret, shipment } from './fixtures/orders';

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, back: vi.fn() }),
  usePathname: () => '/store-1/orders',
}));

const actions = vi.hoisted(() => ({
  cancelOrderAction: vi.fn(),
  lowerLineItemAction: vi.fn(),
  cancelLineItemAction: vi.fn(),
  createRefundAction: vi.fn(),
  createReturnAction: vi.fn(),
  receiveReturnAction: vi.fn(),
  createShipmentAction: vi.fn(),
  updateShipmentAction: vi.fn(),
  pickShipmentAction: vi.fn(),
  packShipmentAction: vi.fn(),
}));
vi.mock('@/app/actions/orders', () => actions);

const ALL: OrderPermissions = {
  canEditOrder: true,
  canRefund: true,
  canRequestReturn: true,
  canFulfil: true,
  canReceiveReturn: true,
};
const NONE: OrderPermissions = {
  canEditOrder: false,
  canRefund: false,
  canRequestReturn: false,
  canFulfil: false,
  canReceiveReturn: false,
};

const success = <T,>(data: T): ActionResult<T> => ({ status: 'success', data });
const failure = (formError: string): ActionResult<never> => ({
  status: 'error',
  fieldErrors: {},
  formError,
});
const refused = (): ActionResult<never> => ({
  status: 'error',
  fieldErrors: {},
  formError: 'You need the support relation on store:brand-a to save this.',
  refusal: {
    status: 403,
    error: {
      code: 'forbidden',
      message: 'requires support on store:brand-a',
      details: { relation: 'support', object: 'store:brand-a' },
    },
  },
});

const query = (overrides: Partial<TableQuery> = {}): TableQuery => ({
  page: 1,
  limit: DEFAULT_LIMIT,
  sort: 'placed_at',
  order: 'desc',
  filters: {},
  ...overrides,
});

const WAREHOUSES = [
  {
    id: IDS.warehouseEu,
    code: 'wh-eu',
    name: 'Europe',
    country: 'NL',
    timezone: 'Europe/Amsterdam',
  },
] as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('orders table', () => {
  it('renders money from minor units in the store locale and each status as a named pill', () => {
    const summary = order();
    render(
      <OrdersTable storeId="store-1" locale="nl-NL" rows={[summary]} total={1} query={query()} />,
    );
    const table = screen.getByRole('table', { name: 'Orders' });
    expect(within(table).getByRole('link', { name: '#1000' })).toHaveAttribute(
      'href',
      `/store-1/orders/${IDS.order}`,
    );
    // 5337 minor EUR in nl-NL: "€ 53,37" (a non-breaking space between symbol and digits).
    expect(within(table).getByText(/53,37/)).toBeInTheDocument();
    expect(within(table).getByText('confirmed')).toBeInTheDocument();
    expect(within(table).getByText('captured')).toBeInTheDocument();
    expect(within(table).getByText('unfulfilled')).toBeInTheDocument();
    expect(ORDERS_TABLE_DEFAULTS.sort).toBe('placed_at');
  });
});

describe('order actions: gating, confirmation and the refund idempotency key', () => {
  it('offers nothing to a principal without the relations, and says so', () => {
    render(
      <OrderActions
        storeId="store-1"
        order={order()}
        locale="en-GB"
        permissions={NONE}
        supportRefundLimitMinor={null}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/does not allow order actions/)).toBeInTheDocument();
  });

  it('offers cancel only while cancellable, refund only with a ceiling, return only with shipped units', () => {
    const { rerender } = render(
      <OrderActions
        storeId="store-1"
        order={order()}
        locale="en-GB"
        permissions={ALL}
        supportRefundLimitMinor={null}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refund' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request return' })).toBeNull();

    rerender(
      <OrderActions
        storeId="store-1"
        order={order({
          status: 'processing',
          items: [line({ quantity: 1, fulfilled_quantity: 1 })],
          payments: [],
        })}
        locale="en-GB"
        permissions={ALL}
        supportRefundLimitMinor={null}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request return' })).toBeInTheDocument();
  });

  it('cancelling asks first, needs a reason, and sends it', async () => {
    const user = userEvent.setup();
    actions.cancelOrderAction.mockResolvedValue(success(order({ status: 'cancelled' })));
    render(
      <OrderActions
        storeId="store-1"
        order={order()}
        locale="en-GB"
        permissions={ALL}
        supportRefundLimitMinor={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(actions.cancelOrderAction).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Yes, cancel the order' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), 'duplicate order');
    await user.click(confirm);
    await waitFor(() =>
      expect(actions.cancelOrderAction).toHaveBeenCalledWith('store-1', IDS.order, {
        reason: 'duplicate order',
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a refund retried after a network failure reuses the idempotency key; the next refund gets a new one', async () => {
    const user = userEvent.setup();
    const minted = ['refund-attempt-alpha', 'refund-attempt-beta'];
    const mintKey = () => minted.shift() ?? 'refund-exhausted';
    actions.createRefundAction
      .mockResolvedValueOnce(
        failure('Could not reach the Admin API. Check it is running, then try again.'),
      )
      .mockResolvedValueOnce(success({ id: 'refund-created' }))
      .mockResolvedValueOnce(success({ id: 'refund-created-again' }));
    render(
      <OrderActions
        storeId="store-1"
        order={order()}
        locale="en-GB"
        permissions={ALL}
        supportRefundLimitMinor={5000}
        mintKey={mintKey}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Refund' }));
    // The ceiling and the support limit are both stated.
    expect(screen.getByText(/Up to €53\.37 can still be refunded/)).toBeInTheDocument();
    expect(screen.getByText(/may refund up to €50\.00 per refund/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Yes, refund/ }));
    await waitFor(() => expect(actions.createRefundAction).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not reach the Admin API/);
    // Still open: retry.
    await user.click(screen.getByRole('button', { name: /Yes, refund/ }));
    await waitFor(() => expect(actions.createRefundAction).toHaveBeenCalledTimes(2));
    const [first, second] = actions.createRefundAction.mock.calls as [unknown[], unknown[]];
    expect(first[2]).toBe('refund-attempt-alpha');
    expect(second[2]).toBe('refund-attempt-alpha');
    expect(first[3]).toEqual({ amount_minor: 5337, reason: 'goodwill' });

    // After the success the form closes; a new refund is a new key.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Refund of €53\.37 requested/),
    );
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    await user.click(screen.getByRole('button', { name: /Yes, refund/ }));
    await waitFor(() => expect(actions.createRefundAction).toHaveBeenCalledTimes(3));
    const third = actions.createRefundAction.mock.calls[2] as unknown[];
    expect(third[2]).toBe('refund-attempt-beta');
  });

  it('a 403 from the refund renders the state panel naming the relation, not a red line', async () => {
    const user = userEvent.setup();
    actions.createRefundAction.mockResolvedValue(refused());
    render(
      <OrderActions
        storeId="store-1"
        order={order()}
        locale="en-GB"
        permissions={ALL}
        supportRefundLimitMinor={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    await user.click(screen.getByRole('button', { name: /Yes, refund/ }));
    expect(await screen.findByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
    expect(screen.getByText(/You need the support relation on store:brand-a/)).toBeInTheDocument();
  });

  it('the refund amount is capped at the ceiling', async () => {
    const user = userEvent.setup();
    render(
      <OrderActions
        storeId="store-1"
        order={order()}
        locale="en-GB"
        permissions={ALL}
        supportRefundLimitMinor={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    const amount = screen.getByLabelText(/Amount/);
    await user.clear(amount);
    await user.type(amount, '99.00');
    expect(screen.getByRole('button', { name: /Yes, refund/ })).toBeDisabled();
    expect(screen.getByText(/At most €53\.37/)).toBeInTheDocument();
  });

  it('a return request lists only shipped units, capped per line', async () => {
    const user = userEvent.setup();
    actions.createReturnAction.mockResolvedValue(success(ret()));
    render(
      <OrderActions
        storeId="store-1"
        order={order({
          items: [
            line({ quantity: 3, fulfilled_quantity: 2 }),
            line({ id: IDS.lineCap, title: 'Cap' }),
          ],
        })}
        locale="en-GB"
        permissions={ALL}
        supportRefundLimitMinor={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Request return' }));
    expect(screen.queryByLabelText(/Cap/)).toBeNull();
    const input = screen.getByLabelText(/Classic Tee/);
    await user.clear(input);
    await user.type(input, '5');
    expect(input).toHaveValue(2);
    await user.click(screen.getByRole('button', { name: 'Yes, request the return' }));
    await waitFor(() =>
      expect(actions.createReturnAction).toHaveBeenCalledWith('store-1', IDS.order, {
        items: [{ order_line_item_id: IDS.lineTee, quantity: 2 }],
      }),
    );
  });
});

describe('line items: edits before fulfilment', () => {
  it('shows no edit controls without store_admin', () => {
    render(<LineItemsPanel storeId="store-1" order={order()} locale="en-GB" canEdit={false} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lowers strictly below the current quantity, after asking', async () => {
    const user = userEvent.setup();
    actions.lowerLineItemAction.mockResolvedValue(success(order()));
    render(<LineItemsPanel storeId="store-1" order={order()} locale="en-GB" canEdit />);
    const [lowerTee] = screen.getAllByRole('button', { name: 'Lower' });
    await user.click(lowerTee as HTMLElement);
    expect(actions.lowerLineItemAction).not.toHaveBeenCalled();
    const input = screen.getByLabelText('New quantity');
    expect(input).toHaveValue(1);
    await user.click(screen.getByRole('button', { name: 'Lower to 1' }));
    await waitFor(() =>
      expect(actions.lowerLineItemAction).toHaveBeenCalledWith('store-1', IDS.order, IDS.lineTee, {
        quantity: 1,
      }),
    );
  });

  it('never offers to cancel the last line, and says why', () => {
    render(
      <LineItemsPanel
        storeId="store-1"
        order={order({ items: [line()] })}
        locale="en-GB"
        canEdit
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel line' })).toBeNull();
    expect(screen.getByText(/cancel the order instead/)).toBeInTheDocument();
  });

  it('offers cancel on a two-line order, asks, and maps a 409 to a message', async () => {
    const user = userEvent.setup();
    actions.cancelLineItemAction.mockResolvedValue(
      failure('line already fulfilled (field: quantity)'),
    );
    render(<LineItemsPanel storeId="store-1" order={order()} locale="en-GB" canEdit />);
    const [cancelTee] = screen.getAllByRole('button', { name: 'Cancel line' });
    await user.click(cancelTee as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Yes, cancel line' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already fulfilled/);
  });

  it('a shipped line is not editable', () => {
    render(
      <LineItemsPanel
        storeId="store-1"
        order={order({ items: [line({ fulfilled_quantity: 1 }), line({ id: IDS.lineCap })] })}
        locale="en-GB"
        canEdit
      />,
    );
    expect(screen.getByText('shipped')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Lower' })).toHaveLength(1);
  });
});

describe('fulfilment panel', () => {
  it('shows lists but no buttons without operations', () => {
    render(
      <FulfilmentPanel
        storeId="store-1"
        order={order({ shipments: [shipment()], returns: [ret()] })}
        locale="en-GB"
        permissions={NONE}
        warehouses={WAREHOUSES}
      />,
    );
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('requested')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('plans a shipment: warehouse + per-line quantities capped at fulfillable, after asking', async () => {
    const user = userEvent.setup();
    actions.createShipmentAction.mockResolvedValue(success(shipment()));
    render(
      <FulfilmentPanel
        storeId="store-1"
        order={order({
          items: [
            line({ quantity: 3, fulfilled_quantity: 1 }),
            line({ id: IDS.lineCap, title: 'Cap' }),
          ],
        })}
        locale="en-GB"
        permissions={ALL}
        warehouses={WAREHOUSES}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Fulfil' }));
    const tee = screen.getByLabelText(/Classic Tee/);
    expect(tee).toHaveValue(2);
    await user.clear(tee);
    await user.type(tee, '9');
    expect(tee).toHaveValue(2);
    await user.click(screen.getByRole('button', { name: 'Yes, plan the shipment' }));
    await waitFor(() =>
      expect(actions.createShipmentAction).toHaveBeenCalledWith('store-1', IDS.order, {
        warehouse_id: IDS.warehouseEu,
        carrier: 'manual',
        items: [
          { order_line_item_id: IDS.lineTee, quantity: 2 },
          // The Cap fixture line defaults to quantity 2 and nothing shipped: all of it is offered.
          { order_line_item_id: IDS.lineCap, quantity: 2 },
        ],
      }),
    );
  });

  it('pick on a pending shipment, pack on a picking one — each asks first', async () => {
    const user = userEvent.setup();
    actions.pickShipmentAction.mockResolvedValue(success(shipment({ status: 'picking' })));
    actions.packShipmentAction.mockResolvedValue(success(shipment({ status: 'packed' })));
    const { rerender } = render(
      <FulfilmentPanel
        storeId="store-1"
        order={order({ shipments: [shipment()] })}
        locale="en-GB"
        permissions={ALL}
        warehouses={WAREHOUSES}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Pick' }));
    expect(actions.pickShipmentAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, start picking' }));
    await waitFor(() =>
      expect(actions.pickShipmentAction).toHaveBeenCalledWith('store-1', IDS.order, IDS.shipment),
    );

    rerender(
      <FulfilmentPanel
        storeId="store-1"
        order={order({ shipments: [shipment({ status: 'picking' })] })}
        locale="en-GB"
        permissions={ALL}
        warehouses={WAREHOUSES}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Pack' }));
    const parcels = screen.getByLabelText('Parcels');
    // A controlled number input that floors at 1: clearing it would type "12", so set it directly.
    fireEvent.change(parcels, { target: { value: '2' } });
    await user.click(screen.getByRole('button', { name: 'Yes, mark packed' }));
    await waitFor(() =>
      expect(actions.packShipmentAction).toHaveBeenCalledWith('store-1', IDS.order, IDS.shipment, {
        parcel_count: 2,
      }),
    );
  });

  it('receives a requested return with a warehouse and a condition per item', async () => {
    const user = userEvent.setup();
    actions.receiveReturnAction.mockResolvedValue(success(ret({ status: 'received' })));
    render(
      <FulfilmentPanel
        storeId="store-1"
        order={order({ returns: [ret()] })}
        locale="en-GB"
        permissions={ALL}
        warehouses={WAREHOUSES}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    await user.selectOptions(screen.getByLabelText('Condition'), 'damaged');
    await user.click(screen.getByRole('button', { name: 'Yes, mark received' }));
    await waitFor(() =>
      expect(actions.receiveReturnAction).toHaveBeenCalledWith('store-1', IDS.order, IDS.ret, {
        warehouse_id: IDS.warehouseEu,
        items: [{ order_line_item_id: IDS.lineTee, quantity: 1, condition: 'damaged' }],
      }),
    );
  });
});

describe('timeline', () => {
  it('renders every entry with its pill', () => {
    render(
      <Timeline
        order={order({
          shipments: [shipment({ status: 'shipped', shipped_at: '2026-09-05T12:00:00Z' })],
        })}
        locale="en-GB"
      />,
    );
    const list = screen.getByRole('list', { name: 'Order timeline' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Shipment shipped')).toBeInTheDocument();
  });
});
