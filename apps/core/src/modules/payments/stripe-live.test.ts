// Live Stripe TEST-MODE integration (#124 acceptance): a real PaymentIntent is created, confirmed with Stripe's
// own test payment method token (`pm_card_visa` — never a raw card number), captured and refunded. Skips itself
// without STRIPE_SECRET_KEY (never committed; repo-root .env). Refuses to run against a live-mode key.
import { describe, expect, it } from 'vitest';
import { StripeClient, StripeError } from './stripe-client';

const key = process.env.STRIPE_SECRET_KEY;
const runnable = Boolean(key && !key.startsWith('sk_live_') && !key.startsWith('rk_live_'));

describe.skipIf(!runnable)('stripe live (test mode)', () => {
  it('creates, confirms (pm_card_visa), captures and refunds a real test-mode PaymentIntent', async () => {
    const client = new StripeClient({ secretKey: key! });
    const created = await client.createPaymentIntent(
      {
        amount: 1234,
        currency: 'eur',
        capture_method: 'manual',
        payment_method_types: ['card'],
        metadata: { cart_id: 'live-test', store_id: 'live-test' },
      },
      { idempotencyKey: `live_create_${Date.now()}` },
    );
    expect(created.id).toMatch(/^pi_/);
    expect(created.client_secret).toContain('_secret_');
    expect(created.status).toBe('requires_payment_method');

    const confirmed = await client.confirmPaymentIntent(created.id, {
      payment_method: 'pm_card_visa',
    });
    expect(confirmed.status).toBe('requires_capture');
    expect(confirmed.amount).toBe(1234);

    const captured = await client.capturePaymentIntent(
      created.id,
      {},
      {
        idempotencyKey: `live_capture_${created.id}`,
        expand: ['latest_charge.balance_transaction'],
      },
    );
    expect(captured.status).toBe('succeeded');
    const charge = captured.latest_charge;
    expect(charge && typeof charge === 'object').toBe(true);

    const refund = await client.createRefund(
      { payment_intent: created.id, amount: 1234 },
      { idempotencyKey: `live_refund_${created.id}` },
    );
    expect(['pending', 'succeeded']).toContain(refund.status);
  }, 60_000);

  it('maps a real decline to a StripeError with the decline code', async () => {
    const client = new StripeClient({ secretKey: key! });
    const created = await client.createPaymentIntent({
      amount: 999,
      currency: 'eur',
      capture_method: 'manual',
      payment_method_types: ['card'],
    });
    const err = await client
      .confirmPaymentIntent(created.id, { payment_method: 'pm_card_chargeDeclined' })
      .catch((e) => e as StripeError);
    expect(err).toBeInstanceOf(StripeError);
    expect((err as StripeError).code).toBe('card_declined');
    expect((err as StripeError).definitive).toBe(true);
  }, 60_000);
});
