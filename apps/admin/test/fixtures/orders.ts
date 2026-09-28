import type { AdminComponents } from '@/lib/api/admin-client';

type Order = AdminComponents['Order'];
type LineItem = AdminComponents['LineItem'];
type Payment = AdminComponents['Payment'];
type Refund = AdminComponents['Refund'];
type Shipment = AdminComponents['Shipment'];
type Return = AdminComponents['Return'];

/** Ids shaped like the contract's own examples; the words at the end name the fixture. */
/** Valid uuids; the tails are hex words so a failing assertion still reads (no digit tails). */
export const IDS = {
  order: '30000000-0000-4000-8000-0000000beef1',
  lineTee: '30000000-0000-4000-8000-00000000face',
  lineCap: '30000000-0000-4000-8000-00000000fade',
  payment: '60000000-0000-4000-8000-00000000feed',
  refund: '60000000-0000-4000-8000-00000000cafe',
  shipment: '60000000-0000-4000-8000-00000000bead',
  ret: '60000000-0000-4000-8000-00000000deaf',
  warehouseEu: '00000000-0000-4000-8000-000000000021',
} as const;

const eur = (amount_minor: number) => ({ amount_minor, currency: 'EUR' });

export function line(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: IDS.lineTee,
    variant_id: '30000000-0000-4000-8000-000000000301',
    sku: 'TEE-M-RED',
    title: 'Classic Tee',
    variant_title: 'M / Red',
    thumbnail_url: null,
    quantity: 2,
    unit_price: eur(1999),
    discount: eur(0),
    tax_rate_bp: 2100,
    tax: eur(840),
    total: eur(4838),
    fulfilled_quantity: 0,
    returned_quantity: 0,
    ...overrides,
  };
}

export function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: IDS.payment,
    provider: 'stripe',
    provider_payment_id: 'pi_words_only',
    amount: eur(5337),
    status: 'captured',
    fee_minor: 62,
    captured_at: '2026-09-04T10:00:05Z',
    ...overrides,
  };
}

export function refund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: IDS.refund,
    order_id: IDS.order,
    payment_id: IDS.payment,
    return_id: null,
    amount: eur(500),
    reason: 'goodwill',
    status: 'succeeded',
    provider_refund_id: 're_words_only',
    created_at: '2026-09-04T11:00:00Z',
    ...overrides,
  };
}

export function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: IDS.shipment,
    order_id: IDS.order,
    warehouse_id: IDS.warehouseEu,
    carrier: 'manual',
    service: null,
    tracking_number: null,
    tracking_url: null,
    label_url: null,
    cost: null,
    status: 'pending',
    items: [{ order_line_item_id: IDS.lineTee, quantity: 1 }],
    shipped_at: null,
    delivered_at: null,
    ...overrides,
  };
}

export function ret(overrides: Partial<Return> = {}): Return {
  return {
    id: IDS.ret,
    order_id: IDS.order,
    status: 'requested',
    reason: 'wrong size',
    warehouse_id: null,
    refund_id: null,
    items: [{ order_line_item_id: IDS.lineTee, quantity: 1, condition: null }],
    requested_at: '2026-09-05T10:00:00Z',
    received_at: null,
    ...overrides,
  };
}

const address = {
  first_name: 'Jane',
  last_name: 'Doe',
  company: null,
  line1: 'Keizersgracht 1',
  line2: null,
  city: 'Amsterdam',
  region: null,
  postal_code: '1015 CC',
  country: 'NL',
  phone: null,
};

/** A confirmed, captured, unfulfilled two-line order — the state most actions are offered in. */
export function order(overrides: Partial<Order> = {}): Order {
  return {
    id: IDS.order,
    display_id: 1000,
    email: 'jane@example.com',
    customer_id: '30000000-0000-4000-8000-000000000a01',
    status: 'confirmed',
    payment_status: 'captured',
    fulfillment_status: 'unfulfilled',
    total: eur(5337),
    placed_at: '2026-09-04T10:00:00Z',
    sales_channel_id: '30000000-0000-4000-8000-000000000001',
    currency: 'EUR',
    locale: 'en-GB',
    items: [
      line(),
      line({
        id: IDS.lineCap,
        sku: 'CAP-ONE',
        title: 'Cap',
        variant_title: 'One size',
        quantity: 1,
        tax: eur(0),
        total: eur(499),
        unit_price: eur(499),
      }),
    ],
    shipping_address: address,
    billing_address: address,
    shipping_method: {
      code: 'standard',
      name: 'Standard (2–4 days)',
      carrier: 'manual',
      price: eur(499),
    },
    promotion_codes: [],
    totals: {
      subtotal: eur(4497),
      discount: eur(0),
      shipping: eur(499),
      tax: eur(840),
      total: eur(5337),
    },
    payments: [payment()],
    refunds: [],
    shipments: [],
    returns: [],
    cancel_reason: null,
    metadata: {},
    ...overrides,
  };
}
