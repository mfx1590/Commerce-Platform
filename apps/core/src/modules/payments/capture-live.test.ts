// Live Stripe TEST-MODE run of the capture → refund chain THROUGH THE MODULE (#355 acceptance): a real
// PaymentIntent created by our `stripe` provider at session time, Stripe's own test payment method token
// (`pm_card_visa` — never a raw card number) attached, the order placed through `completeCart` (our `authorize`
// confirms server-side), captured with `capturePayment` (full, then a partial one on a second order) and refunded
// with `createRefund`. Needs `STRIPE_SECRET_KEY_BRAND_A` (the seeded store's suffix) or `STRIPE_SECRET_KEY` in the
// repo-root .env — never committed, never in chat — and a Postgres for the throwaway database. Skips LOUDLY
// otherwise (a warning names the variables), refuses a live-mode key.
import { randomUUID } from 'node:crypto';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import { completeCart, createPaymentSession, setPaymentProvider } from '../checkout';
import {
  capturePayment,
  createRefund,
  createStripePaymentProvider,
  StripeClient,
  stripeCredentialsFor,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const KEY_VARIABLES = ['STRIPE_SECRET_KEY_BRAND_A', 'STRIPE_SECRET_KEY'];
const key = process.env.STRIPE_SECRET_KEY_BRAND_A ?? process.env.STRIPE_SECRET_KEY;
const runnable = Boolean(key && !key.startsWith('sk_live_') && !key.startsWith('rk_live_'));
if (!runnable) {
  console.warn(
    `[payments] capture-live.test.ts SKIPPED: set one of ${KEY_VARIABLES.join(' / ')} (a Stripe TEST-mode key, sk_test_…) in the repo-root .env to run the live capture → refund chain`,
  );
}

const customer = { id: null, type: 'customer' as const, requestId: 'req-capture-live' };
const staff = {
  id: SEED_IDS.users.storeAdmin,
  type: 'staff' as const,
  requestId: 'req-capture-live',
};
const address = {
  first_name: 'Jane',
  last_name: 'Doe',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let variants: { id: string }[];
let standardOptionId: string;
let stripe: StripeClient;

describe.skipIf(!runnable)(
  'stripe live (test mode): place → capture → refund through the module',
  () => {
    beforeAll(async () => {
      db = await createTestDatabase('core_capture_live');
      await seed(db.owner, { log: () => {} });
      owner = createOrganizationClient(db.owner, { organizationId: ORG });
      a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
      const codeA = (
        await owner.query<{ code: string }>(`SELECT code FROM store WHERE id = $1`, [A])
      ).rows[0]!.code;
      // The same resolution the provider uses (store suffix over the global variable, live keys refused).
      stripe = new StripeClient({ secretKey: stripeCredentialsFor(codeA, process.env).secretKey });
      setPaymentProvider(createStripePaymentProvider({ env: process.env }));
      const channel = await owner.query<{ id: string }>(
        `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
        [A],
      );
      scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
      const vs = await owner.query<{ id: string }>(
        `SELECT v.id
       FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
       JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
       WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder
         AND coalesce((SELECT sum(il.available) FROM inventory_level il WHERE il.variant_id = v.id), 0) >= 10
       ORDER BY v.sku`,
        [A],
      );
      variants = vs.rows;
      const opt = await owner.query<{ id: string }>(
        `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
        [A],
      );
      standardOptionId = opt.rows[0]!.id;
    }, 180_000);

    afterAll(async () => {
      await db?.drop();
    });

    let counter = 0;
    /** A real test-mode order: stripe session (real intent) → pm_card_visa attached → placed (authorised). */
    async function placedOrder(): Promise<{
      orderId: string;
      paymentId: string;
      intentId: string;
      amount: number;
    }> {
      const n = counter++;
      const cart = await createCart(a, scopeA, {});
      await addLineItem(a, cart.id, { variant_id: variants[n % variants.length]!.id, quantity: 1 });
      await updateCart(a, cart.id, {
        email: `jane.doe+live${n}@example.com`,
        shipping_address: address,
        billing_address: { ...address, country: 'NL' },
        shipping_option_id: standardOptionId,
      });
      const session = await createPaymentSession(a, cart.id, { provider: 'stripe' });
      expect(session.session_id).toMatch(/^pi_/);
      // What the storefront's Payment Element does with the shopper's card, done here with Stripe's test token.
      const attached = await stripe.updatePaymentIntent(session.session_id, {
        payment_method: 'pm_card_visa',
      });
      expect(attached.status).toBe('requires_confirmation');
      const { order } = await completeCart(a, {
        cartId: cart.id,
        idempotencyKey: `live-place-${randomUUID()}`,
        actor: customer,
      });
      const p = await owner.query<{
        id: string;
        provider_payment_id: string;
        amount_minor: string;
      }>(`SELECT id, provider_payment_id, amount_minor::text FROM payment WHERE order_id = $1`, [
        order.id,
      ]);
      return {
        orderId: order.id,
        paymentId: p.rows[0]!.id,
        intentId: p.rows[0]!.provider_payment_id,
        amount: Number(p.rows[0]!.amount_minor),
      };
    }

    it('full capture, then a refund of the captured amount', async () => {
      const { orderId, paymentId, intentId, amount } = await placedOrder();
      expect((await stripe.retrievePaymentIntent(intentId)).status).toBe('requires_capture');

      const captured = await capturePayment(a, paymentId, { actor: staff, orderId });
      expect(captured.replayed).toBe(false);
      expect(captured.payment).toMatchObject({ status: 'captured', amount_minor: String(amount) });
      expect(captured.payment.fee_minor).not.toBeNull(); // the expanded balance transaction
      const intent = await stripe.retrievePaymentIntent(intentId);
      expect(intent.status).toBe('succeeded');
      expect(intent.amount_received).toBe(amount);

      const { refund } = await createRefund(a, {
        orderId,
        paymentId,
        amountMinor: amount,
        reason: 'goodwill',
        idempotencyKey: `live-refund-${paymentId}`,
        actor: staff,
      });
      expect(['pending', 'succeeded']).toContain(refund.status);
      expect(refund.provider_refund_id).toMatch(/^re_/);
    }, 90_000);

    it('partial capture releases the rest of the hold; the refund ceiling is the captured amount', async () => {
      const { orderId, paymentId, intentId, amount } = await placedOrder();
      const part = amount - 100;
      const captured = await capturePayment(a, paymentId, {
        actor: staff,
        orderId,
        amountMinor: part,
      });
      expect(captured.payment.amount_minor).toBe(String(part));
      const intent = await stripe.retrievePaymentIntent(intentId);
      expect(intent.status).toBe('succeeded');
      expect(intent.amount_received).toBe(part);

      await expect(
        createRefund(a, {
          orderId,
          paymentId,
          amountMinor: part + 1,
          reason: 'goodwill',
          idempotencyKey: `live-refund-over-${paymentId}`,
          actor: staff,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      const { refund } = await createRefund(a, {
        orderId,
        paymentId,
        amountMinor: part,
        reason: 'goodwill',
        idempotencyKey: `live-refund-${paymentId}`,
        actor: staff,
      });
      expect(['pending', 'succeeded']).toContain(refund.status);
    }, 90_000);
  },
);
