/**
 * Bulk capture (#870 wave 1 item 2, the money PR): which payment and how much (`planCapture`), the
 * per-currency totals, and the two server actions — refused up front and per row, ticked ids only
 * and at most 100, the confirmed amounts re-checked before each call, every API answer reported,
 * an unknown outcome never retried.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from './fixtures/principals';
import type { AdminComponents } from '@/lib/api/admin-client';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({ getOrder: vi.fn(), capturePayment: vi.fn() }));
vi.mock('@/lib/api/admin', () => api);

const { BULK_CAPTURE_CAP, describeTotals, planCapture, totalsByCurrency } =
  await import('@/lib/orders/bulk-capture');
const { bulkCaptureAction, previewBulkCaptureAction } = await import('@/app/actions/bulk-capture');

const STORE = SEED.stores.brandA;
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payId = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const money = (amount_minor: number, currency: string) => ({ amount_minor, currency });
const payment = (n: number, status: string, authorized: number, currency = 'JPY') => ({
  id: payId(n),
  provider: 'stripe',
  provider_payment_id: `pi_${n}`,
  amount: money(authorized, currency),
  status,
  fee_minor: null,
  captured_at: null,
});
type Order = AdminComponents['Order'];
/** An order as the API sends it (the fixture's strings are the contract's enum values). */
const order = (
  n: number,
  { total = 1200, currency = 'JPY', payments = [payment(n, 'authorized', 1200, currency)] } = {},
) =>
  ({
    id: id(n),
    display_id: 1000 + n,
    status: 'confirmed',
    payment_status: payments.some((p) => p.status === 'captured') ? 'captured' : 'authorized',
    total: money(total, currency),
    payments,
  }) as unknown as Order;
const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code: string, message: string) => ({
  ok: false as const,
  status,
  error: { code, message },
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.getOrder.mockImplementation((_s: string, orderId: string) =>
    Promise.resolve(ok(order(Number(orderId.slice(-3))))),
  );
  api.capturePayment.mockImplementation((_s: string, _o: string, paymentId: string) =>
    Promise.resolve(ok({ id: paymentId, status: 'captured' })),
  );
});

describe('planCapture: which payment, how much', () => {
  it('the whole authorisation when the order still costs it (no amount sent)', () => {
    expect(planCapture(order(1))).toMatchObject({
      capturable: true,
      paymentId: payId(1),
      amountMinor: 1200,
      partial: false,
    });
  });

  it('an order edited down captures its CURRENT total (partial)', () => {
    expect(planCapture(order(1, { total: 900 }))).toMatchObject({
      capturable: true,
      amountMinor: 900,
      authorizedMinor: 1200,
      partial: true,
    });
  });

  it('never more than the authorisation, even when the total grew', () => {
    expect(planCapture(order(1, { total: 5000 }))).toMatchObject({
      amountMinor: 1200,
      partial: false,
    });
  });

  it('not capturable: already captured, none authorised, two authorised, another currency, total 0', () => {
    expect(planCapture(order(1, { payments: [payment(1, 'captured', 1200)] }))).toMatchObject({
      capturable: false,
      alreadyCaptured: true,
      reason: 'Already captured.',
    });
    expect(planCapture(order(1, { payments: [payment(1, 'failed', 1200)] }))).toMatchObject({
      capturable: false,
      alreadyCaptured: false,
    });
    expect(
      planCapture(
        order(1, { payments: [payment(1, 'authorized', 600), payment(2, 'authorized', 600)] }),
      ),
    ).toMatchObject({
      capturable: false,
      reason: expect.stringContaining('2 authorised payments'),
    });
    expect(planCapture({ ...order(1), total: money(1200, 'EUR') })).toMatchObject({
      capturable: false,
      reason: expect.stringContaining('JPY'),
    });
    expect(planCapture(order(1, { total: 0 }))).toMatchObject({ capturable: false });
  });
});

describe('totals per currency', () => {
  it('summed per currency, never across currencies', () => {
    expect(
      totalsByCurrency([
        { amountMinor: 1200, currency: 'JPY' },
        { amountMinor: 4550, currency: 'EUR' },
        { amountMinor: 800, currency: 'JPY' },
      ]),
    ).toEqual({ JPY: 2000, EUR: 4550 });
  });

  it('formatted with each currency’s own decimals (JPY has none)', () => {
    expect(describeTotals({ JPY: 120000, EUR: 4550 })).toBe('€45.50 · JP¥120,000');
  });
});

describe('previewBulkCaptureAction (reads only)', () => {
  it('store_staff is refused before any read (capturePayment is store_admin)', async () => {
    principalOf.current = 'storeStaff';
    expect(await previewBulkCaptureAction(STORE, [id(1)])).toMatchObject({
      status: 'error',
      refusal: { status: 403, error: { details: { relation: 'store_admin' } } },
    });
    expect(api.getOrder).not.toHaveBeenCalled();
  });

  it(`more than ${BULK_CAPTURE_CAP} ticked orders is refused before any read`, async () => {
    const ids = Array.from({ length: BULK_CAPTURE_CAP + 1 }, (_, i) => id(i + 1));
    expect(await previewBulkCaptureAction(STORE, ids)).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('at most 100'),
    });
    expect(api.getOrder).not.toHaveBeenCalled();
  });

  it('per order what it would capture, and the totals per currency; nothing captured', async () => {
    api.getOrder.mockImplementation((_s: string, orderId: string) => {
      const n = Number(orderId.slice(-3));
      if (n === 2)
        return Promise.resolve(
          ok(
            order(2, {
              total: 4550,
              currency: 'EUR',
              payments: [payment(2, 'authorized', 5000, 'EUR')],
            }),
          ),
        );
      if (n === 3)
        return Promise.resolve(ok(order(3, { payments: [payment(3, 'captured', 1200)] })));
      return Promise.resolve(ok(order(n)));
    });
    const result = await previewBulkCaptureAction(STORE, [id(1), id(2), id(3)]);
    expect(api.capturePayment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'success',
      data: {
        capturable: 2,
        totals: { JPY: 1200, EUR: 4550 },
        rows: [
          {
            id: id(1),
            label: '#1001',
            capturable: true,
            amountMinor: 1200,
            currency: 'JPY',
            message: 'JP¥1,200',
          },
          {
            id: id(2),
            capturable: true,
            amountMinor: 4550,
            partial: true,
            message: '€45.50 of €50.00 authorised (the order total is lower now).',
          },
          { id: id(3), capturable: false, message: 'Already captured.' },
        ],
      },
    });
  });
});

describe('bulkCaptureAction', () => {
  const confirmed = (n: number, amountMinor = 1200, currency = 'JPY') => ({
    id: id(n),
    amountMinor,
    currency,
  });

  it('store_staff is refused before any read or capture', async () => {
    principalOf.current = 'storeStaff';
    expect(await bulkCaptureAction(STORE, [confirmed(1)])).toMatchObject({
      status: 'error',
      refusal: { status: 403 },
    });
    expect(api.getOrder).not.toHaveBeenCalled();
    expect(api.capturePayment).not.toHaveBeenCalled();
  });

  it(`more than ${BULK_CAPTURE_CAP} rows is refused before anything`, async () => {
    const rows = Array.from({ length: BULK_CAPTURE_CAP + 1 }, (_, i) => confirmed(i + 1));
    expect((await bulkCaptureAction(STORE, rows)).status).toBe('error');
    expect(api.capturePayment).not.toHaveBeenCalled();
  });

  it('confirmed amounts that are not positive whole minor units are refused', async () => {
    expect((await bulkCaptureAction(STORE, [confirmed(1, 0)])).status).toBe('error');
    expect((await bulkCaptureAction(STORE, [confirmed(1, 1.5)])).status).toBe('error');
    expect((await bulkCaptureAction(STORE, [confirmed(1, 1200, 'yen')])).status).toBe('error');
    expect(api.capturePayment).not.toHaveBeenCalled();
  });

  it('always sends amount_minor: the whole authorisation, or the lower total (#913 review)', async () => {
    api.getOrder.mockImplementation((_s: string, orderId: string) =>
      Promise.resolve(ok(orderId === id(2) ? order(2, { total: 900 }) : order(1))),
    );
    const result = await bulkCaptureAction(STORE, [confirmed(1), confirmed(2, 900)]);
    expect(
      api.capturePayment.mock.calls.map(([, orderId, paymentId, body]) => [
        orderId,
        paymentId,
        body,
      ]),
    ).toEqual([
      [id(1), payId(1), { amount_minor: 1200 }],
      [id(2), payId(2), { amount_minor: 900 }],
    ]);
    expect(result).toMatchObject({
      status: 'success',
      data: {
        counts: { done: 2 },
        results: [
          { label: '#1001', message: 'Captured JP¥1,200.' },
          {
            label: '#1002',
            message: 'Captured JP¥900 of the JP¥1,200 authorised (the order total is lower now).',
          },
        ],
      },
    });
  });

  it('an amount that changed since the preview is not captured', async () => {
    api.getOrder.mockResolvedValue(ok(order(1, { total: 1000 })));
    const result = await bulkCaptureAction(STORE, [confirmed(1, 1200)]);
    expect(api.capturePayment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      data: {
        results: [{ outcome: 'skipped', message: expect.stringContaining('JP¥1,200 → JP¥1,000') }],
      },
    });
  });

  it('already captured on the fresh read: skipped without a call', async () => {
    api.getOrder.mockResolvedValue(ok(order(1, { payments: [payment(1, 'captured', 1200)] })));
    const result = await bulkCaptureAction(STORE, [confirmed(1)]);
    expect(api.capturePayment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      data: { results: [{ outcome: 'skipped', message: 'Already captured.' }] },
    });
  });

  it('the API’s 409 and 422 are said in its words; neither is a failure to retry', async () => {
    api.capturePayment
      .mockResolvedValueOnce(fail(409, 'conflict', 'payment is already captured'))
      .mockResolvedValueOnce(
        fail(422, 'provider_unsupported', 'the manual provider has nothing to capture'),
      );
    const result = await bulkCaptureAction(STORE, [confirmed(1), confirmed(2)]);
    expect(result).toMatchObject({
      data: {
        results: [
          { outcome: 'skipped', message: 'Not captured: payment is already captured.' },
          {
            outcome: 'skipped',
            message: 'Not capturable: the manual provider has nothing to capture.',
          },
        ],
      },
    });
  });

  it.each([0, 502, 504])(
    'status %i: outcome unknown, called once, never retried',
    async (status) => {
      api.capturePayment.mockResolvedValue(fail(status, 'network_error', 'socket hang up'));
      const result = await bulkCaptureAction(STORE, [confirmed(1)]);
      expect(api.capturePayment).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        data: {
          results: [
            {
              outcome: 'unknown',
              message: expect.stringContaining('check this row before running it again'),
            },
          ],
        },
      });
    },
  );

  it('the principal is loaded once for the action, then checked per row', async () => {
    const principal = await import('@/lib/principal');
    const spy = vi.spyOn(principal, 'loadPrincipal');
    await bulkCaptureAction(STORE, [confirmed(1), confirmed(2), confirmed(3), confirmed(4)]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(api.capturePayment).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });
});

describe('#913 review', () => {
  it('a payment of another provider is not capturable and stays out of the totals', async () => {
    api.getOrder.mockImplementation((_s: string, orderId: string) => {
      const n = Number(orderId.slice(-3));
      const o = order(n);
      if (n === 2) o.payments[0]!.provider = 'manual';
      return Promise.resolve(ok(o));
    });
    const result = await previewBulkCaptureAction(STORE, [id(1), id(2)]);
    expect(result).toMatchObject({
      status: 'success',
      data: {
        capturable: 1,
        totals: { JPY: 1200 },
        rows: [
          { id: id(1), capturable: true },
          {
            id: id(2),
            capturable: false,
            message: 'Paid through the manual provider: there is nothing to capture here.',
          },
        ],
      },
    });
    // And at capture time it is not sent either.
    await bulkCaptureAction(STORE, [{ id: id(2), amountMinor: 1200, currency: 'JPY' }]);
    expect(api.capturePayment).not.toHaveBeenCalled();
  });

  it('a throw inside a capture row is "unknown", never "failed", and is not retried', async () => {
    api.capturePayment.mockRejectedValue(new Error('socket closed after write'));
    const result = await bulkCaptureAction(STORE, [
      { id: id(1), amountMinor: 1200, currency: 'JPY' },
    ]);
    expect(api.capturePayment).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      data: { counts: { unknown: 1, failed: 0 }, results: [{ outcome: 'unknown' }] },
    });
  });

  it('the results CSV carries amount_minor, currency and payment_id for every planned row', async () => {
    const { reportCsv } = await import('@/lib/table/csv');
    api.capturePayment
      .mockResolvedValueOnce(ok({ id: payId(1), status: 'captured' }))
      .mockResolvedValueOnce(fail(409, 'conflict', 'payment is already captured'));
    const result = await bulkCaptureAction(STORE, [
      { id: id(1), amountMinor: 1200, currency: 'JPY' },
      { id: id(2), amountMinor: 1200, currency: 'JPY' },
    ]);
    const csv = result.status === 'success' ? reportCsv(result.data.results) : '';
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('id,name,result,message,amount_minor,currency,payment_id');
    expect(lines[1]).toBe(
      `${id(1)},#1001,done,Captured JP¥1,200.,1200,JPY,${payId(1)}`.replace(
        'Captured JP¥1,200.',
        '"Captured JP¥1,200."',
      ),
    );
    expect(lines[2]).toBe(
      `${id(2)},#1002,skipped,Not captured: payment is already captured.,1200,JPY,${payId(2)}`,
    );
  });
});
