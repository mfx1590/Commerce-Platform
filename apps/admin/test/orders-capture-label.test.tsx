import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentsPanel } from '@/app/(store)/[storeId]/orders/[orderId]/payments-panel';
import { FulfilmentPanel } from '@/app/(store)/[storeId]/orders/[orderId]/shipments-panel';
import { OrderActions } from '@/app/(store)/[storeId]/orders/[orderId]/order-actions';
import type { ActionResult } from '@/lib/forms/action-result';
import { capturable, orderStatusMeaning } from '@/lib/orders/lifecycle';
import { orderPermissions, type OrderPermissions } from '@/lib/orders/permissions';
import { forActions, forFulfilment, forPayments } from '@/lib/orders/projection';
import { IDS, order, payment, shipment } from './fixtures/orders';
import { SEED, principals } from './fixtures/principals';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/store-1/orders',
}));
const actions = vi.hoisted(() => ({
  capturePaymentAction: vi.fn(),
  buyShipmentLabelAction: vi.fn(),
  cancelOrderAction: vi.fn(),
  createRefundAction: vi.fn(),
  createReturnAction: vi.fn(),
  createShipmentAction: vi.fn(),
  updateShipmentAction: vi.fn(),
  pickShipmentAction: vi.fn(),
  packShipmentAction: vi.fn(),
  receiveReturnAction: vi.fn(),
}));
vi.mock('@/app/actions/orders', () => actions);

const STORE = 's1';
const authorised = payment({
  status: 'authorized',
  captured_at: null,
  amount: { amount_minor: 5337, currency: 'EUR' },
});
const unavailable = (formError: string): ActionResult<never> => ({
  status: 'error',
  fieldErrors: {},
  formError,
  unavailable: true,
});

const PERMS = (overrides: Partial<OrderPermissions>): OrderPermissions => ({
  canEditOrder: false,
  canCapture: false,
  canRefund: false,
  canRequestReturn: false,
  canFulfil: false,
  canReceiveReturn: false,
  canBuyLabel: false,
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe('who is offered capture and label', () => {
  it.each([
    ['owner', true, true],
    ['storeAdmin', true, false],
    ['operations', false, true],
    ['support', false, false],
    ['storeStaff', false, false],
  ] as const)('%s: capture %s, buy label %s', (role, capture, label) => {
    const permissions = orderPermissions(principals[role], SEED.stores.brandA);
    expect(permissions.canCapture).toBe(capture);
    expect(permissions.canBuyLabel).toBe(label);
  });

  it('only an authorized payment is capturable', () => {
    for (const status of ['pending', 'captured', 'failed', 'cancelled'] as const) {
      expect(capturable(payment({ status }))).toBe(false);
    }
    expect(capturable(authorised)).toBe(true);
  });
});

describe('Capture (payments card)', () => {
  const renderPanel = (canCapture = true) =>
    render(
      <PaymentsPanel
        storeId={STORE}
        order={forPayments(
          order({
            payments: [authorised, payment({ id: '60000000-0000-4000-8000-00000000f00d' })],
          }),
        )}
        locale="en-GB"
        canCapture={canCapture}
      />,
    );

  it('is offered on the authorized payment only, and asks before it sends the whole amount', async () => {
    const user = userEvent.setup();
    actions.capturePaymentAction.mockResolvedValue({
      status: 'success',
      data: { ...authorised, status: 'captured' },
    });
    renderPanel();
    expect(screen.getAllByRole('button', { name: 'Capture' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Capture' }));
    expect(screen.getByRole('alertdialog', { name: 'Confirm capture' })).toHaveTextContent(
      /whole authorised €53.37/,
    );
    expect(actions.capturePaymentAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(actions.capturePaymentAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Capture' }));
    await user.click(screen.getByRole('button', { name: 'Yes, capture' }));
    expect(actions.capturePaymentAction).toHaveBeenCalledWith(STORE, IDS.order, IDS.payment, {});
    expect(await screen.findByText('Payment captured.')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('a partial capture sends minor units and never more than authorised', async () => {
    const user = userEvent.setup();
    actions.capturePaymentAction.mockResolvedValue({ status: 'success', data: authorised });
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Capture' }));
    await user.click(screen.getByLabelText('Capture only part of it'));
    const amount = screen.getByLabelText(/^Amount to capture/);
    await user.clear(amount);
    await user.type(amount, '60.00');
    await user.click(screen.getByRole('button', { name: 'Yes, capture' }));
    expect(actions.capturePaymentAction).not.toHaveBeenCalled();
    expect(screen.getByText('Enter an amount up to the authorised amount.')).toBeInTheDocument();

    await user.clear(amount);
    await user.type(amount, '20.00');
    await user.click(screen.getByRole('button', { name: 'Yes, capture' }));
    expect(actions.capturePaymentAction).toHaveBeenCalledWith(STORE, IDS.order, IDS.payment, {
      amount_minor: 2000,
    });
  });

  it('the manual provider (422 provider_unsupported) is a neutral note, not an error', async () => {
    const user = userEvent.setup();
    actions.capturePaymentAction.mockResolvedValue(
      unavailable(
        'Capture is not available for this payment provider — it has nothing to capture.',
      ),
    );
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Capture' }));
    await user.click(screen.getByRole('button', { name: 'Yes, capture' }));
    expect(await screen.findByTestId('capture-unavailable')).toHaveTextContent(
      /not available for this payment provider/,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a 409 is shown as a message', async () => {
    const user = userEvent.setup();
    actions.capturePaymentAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError:
        'This payment cannot be captured as asked: already captured. Reload to see its current state.',
    });
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Capture' }));
    await user.click(screen.getByRole('button', { name: 'Yes, capture' }));
    expect(await screen.findByText(/cannot be captured as asked/)).toBeInTheDocument();
  });

  it('without store_admin there is no Capture', () => {
    renderPanel(false);
    expect(screen.queryByRole('button', { name: 'Capture' })).toBeNull();
  });
});

describe('Buy label (shipments)', () => {
  const renderPanel = (
    shipments: ReturnType<typeof shipment>[],
    perms: Partial<OrderPermissions>,
  ) =>
    render(
      <FulfilmentPanel
        storeId={STORE}
        order={forFulfilment(order({ shipments }))}
        locale="en-GB"
        permissions={PERMS(perms)}
        warehouses={[]}
      />,
    );

  it('is offered on a packed shipment to operations, and asks first', async () => {
    const user = userEvent.setup();
    actions.buyShipmentLabelAction.mockResolvedValue({
      status: 'success',
      data: shipment({ status: 'label_created' }),
    });
    renderPanel([shipment({ status: 'packed', carrier: 'easypost' })], {
      canFulfil: true,
      canBuyLabel: true,
    });
    await user.click(screen.getByRole('button', { name: 'Buy label' }));
    expect(screen.getByRole('alertdialog', { name: 'Confirm buying a label' })).toHaveTextContent(
      /easypost label/,
    );
    expect(actions.buyShipmentLabelAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, buy label' }));
    expect(actions.buyShipmentLabelAction).toHaveBeenCalledWith(STORE, IDS.order, IDS.shipment);
    expect(refresh).toHaveBeenCalled();
  });

  it('is not offered before packed, nor without the relation', () => {
    renderPanel([shipment({ status: 'picking' })], { canFulfil: true, canBuyLabel: true });
    expect(screen.queryByRole('button', { name: 'Buy label' })).toBeNull();
  });

  it('afterwards the row shows the label link and the tracking number', () => {
    renderPanel(
      [
        shipment({
          status: 'label_created',
          label_url: 'https://labels.example/label-1.png',
          tracking_number: 'EZ1000000001',
          tracking_url: 'https://track.example/EZ1000000001',
        }),
      ],
      {},
    );
    expect(screen.getByRole('link', { name: 'Label' })).toHaveAttribute(
      'href',
      'https://labels.example/label-1.png',
    );
    expect(screen.getByRole('link', { name: 'EZ1000000001' })).toBeInTheDocument();
  });

  it('the manual carrier (422 provider_unsupported) points at Update, neutrally', async () => {
    const user = userEvent.setup();
    actions.buyShipmentLabelAction.mockResolvedValue(
      unavailable(
        "Buying a label is not available for this shipment's carrier — attach the tracking number with Update instead.",
      ),
    );
    renderPanel([shipment({ status: 'packed' })], { canFulfil: true, canBuyLabel: true });
    await user.click(screen.getByRole('button', { name: 'Buy label' }));
    await user.click(screen.getByRole('button', { name: 'Yes, buy label' }));
    expect(await screen.findByTestId('label-unavailable')).toHaveTextContent(/with Update instead/);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('order status and refunds', () => {
  it('each status the core reports has its #350 meaning', () => {
    expect(orderStatusMeaning('confirmed')).toMatch(/authorised/);
    expect(orderStatusMeaning('processing')).toMatch(/shipment/);
    expect(orderStatusMeaning('completed')).toMatch(/delivered/);
  });

  it('the refund form keeps listing captured payments only', async () => {
    const user = userEvent.setup();
    const second = payment({
      id: '60000000-0000-4000-8000-00000000f00d',
      amount: { amount_minor: 1000, currency: 'EUR' },
    });
    render(
      <OrderActions
        storeId={STORE}
        order={forActions(order({ payments: [payment(), second, authorised] }))}
        locale="en-GB"
        permissions={PERMS({ canRefund: true })}
        supportRefundLimitMinor={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    const values = within(screen.getByLabelText(/^Payment/))
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    // The placeholder and the two captured payments; never the authorized one.
    expect(values).toEqual(['', IDS.payment, second.id]);
  });
});
