// Checkout module (issue #104): shipping options, payment session, and placement — ONE transaction on the locked
// cart that writes "order" + order_line_item + payment, records attribution (src/lib/attribution.ts), emits
// `order.placed` v1 through the outbox and marks the cart completed. Idempotency lives on
// `payment.idempotency_key` (0006, UNIQUE): a replayed key returns the stored order without touching the
// provider; a different key on a completed cart is 409 `cart_completed`. Integer minor units throughout.
import { createHash } from 'node:crypto';
import type { Queryable, ScopedClient } from '@platform/db';
import { orderMetadataFromCart, recordAttribution } from '../../lib/attribution';
import { AppError, notFound, validationError } from '../../lib/errors';
import {
  currentFraudCheck,
  evaluateFraud,
  FRAUD_CHECK_UNAVAILABLE,
  FRAUD_OUTAGE_PROVIDER,
  type BlockedPlacement,
} from '../../lib/fraud-seam';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import {
  currentDiscountEvaluator,
  currentShippingRateProvider,
  loadCart,
  loadLines,
  lockActiveCart,
  lineTaxOf,
  lineTotalWith,
  recalculate,
  repriceLines,
  type CartLineRow,
  type PriceChange,
  type CartRow,
  type PricingContext,
} from '../cart';
import { reserveForOrder } from '../inventory';
import { flagOrderForReview, renderStoreOrder } from '../orders';
import { paymentProvider, registeredPaymentProviders } from './payment';
import type {
  CompleteCartInput,
  CompleteCartResult,
  PaymentCartRef,
  StorePaymentSession,
  StoreShippingOption,
} from './types';

/** `email_hash` of the events (common/v1 `sha256`): sha256 hex of the trimmed, lowercased email. Never the raw value. */
/** Keys of `order.metadata` written by the core itself, never taken from the storefront's cart metadata. */
const RESERVED_ORDER_METADATA_KEYS = ['fraud', 'promotions'] as const;

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function pricingContext(tx: Queryable, cart: CartRow, lines: CartLineRow[]): PricingContext {
  return {
    tx,
    organizationId: cart.organization_id,
    storeId: cart.store_id,
    salesChannelId: cart.sales_channel_id,
    currency: cart.currency,
    country: cart.country,
    shippingAddress: cart.shipping_address,
    lines: lines.map((l) => ({
      lineItemId: l.id,
      variantId: l.variant_id,
      productId: l.product_id,
      categoryId: l.category_id,
      quantity: l.quantity,
      unitPriceMinor: Number(l.unit_price_minor),
      discountMinor: Number(l.discount_minor),
    })),
  };
}

/** `GET /store/carts/{cartId}/shipping-options`: what the ShippingRateProvider offers for the cart's destination. */
export async function listShippingOptions(
  client: ScopedClient,
  cartId: string,
): Promise<StoreShippingOption[]> {
  return client.transaction(async (tx) => {
    const cart = await loadCart(tx, cartId, false);
    const lines = await loadLines(tx, cartId);
    const rates = await currentShippingRateProvider().list(pricingContext(tx, cart, lines));
    return rates.map((r) => ({
      id: r.optionId,
      code: r.code,
      name: r.name,
      carrier: r.carrier,
      price: { amount_minor: r.priceMinor, currency: r.currency },
    }));
  });
}

function cartRef(cart: CartRow): PaymentCartRef {
  return {
    cartId: cart.id,
    organizationId: cart.organization_id,
    storeId: cart.store_id,
    currency: cart.currency,
    amountMinor: Number(cart.total_minor),
    email: cart.email ? cart.email.trim().toLowerCase() : null,
  };
}

/**
 * `POST /store/carts/{cartId}/payment-session`: creates a provider session for the cart's current total and stores
 * it on `cart.payment_session` (contract `PaymentSession` shape — ids and amounts, never card data). Calling it
 * again replaces the session (the storefront does so right before completing, when the total may have changed).
 */
export async function createPaymentSession(
  client: ScopedClient,
  cartId: string,
  input: { provider: string },
): Promise<StorePaymentSession> {
  const provider = paymentProvider(input.provider);
  if (!provider) {
    throw validationError(`payment provider ${input.provider} is not available`, {
      provider: `one of ${registeredPaymentProviders().join(', ')}`,
    });
  }
  return client.transaction(async (tx) => {
    const cart = await lockActiveCart(tx, cartId);
    const created = await provider.createSession({ tx, cart: cartRef(cart) });
    const session: StorePaymentSession = {
      provider: provider.name,
      session_id: created.sessionId,
      client_secret: created.clientSecret,
      status: created.status,
      amount: { amount_minor: Number(cart.total_minor), currency: cart.currency },
    };
    await tx.query(
      `UPDATE cart SET payment_session = $2::jsonb, updated_at = now() WHERE id = $1`,
      [cartId, JSON.stringify(session)],
    );
    return session;
  });
}

interface OrderInsertRow {
  id: string;
  display_id: string;
  placed_at: Date;
}

interface LineInsertRow {
  id: string;
  variant_id: string | null;
  sku: string;
  title: string;
  quantity: number;
  unit_price_minor: string;
  discount_minor: string;
  tax_rate_bp: number;
  tax_minor: string;
  total_minor: string;
}

/**
 * `POST /store/carts/{cartId}/complete` (Idempotency-Key required). Replay: a `payment` row with this key → the
 * stored order (no provider call, no second transaction). Otherwise, on the locked active cart: preconditions
 * (items, email, both addresses, shipping option, payment session) → totals refreshed → stock re-checked →
 * provider `authorize` (failed → 402 `payment_failed`, nothing written) → "order" (display_id from the store-row
 * trigger) → order_line_item → payment (carries the key) → attribution rows + `attribution.recorded` →
 * `order.placed` v1 → cart completed. Any throw rolls all of it back.
 */
export async function completeCart(
  client: ScopedClient,
  input: CompleteCartInput,
): Promise<CompleteCartResult> {
  try {
    return await placeOrder(client, input);
  } catch (error) {
    if (error instanceof FraudBlockedSignal) {
      // #241: the placement transaction has rolled back and its connection is released — only now may the fraud
      // module write its block record (own transaction). Best effort; the answer below never depends on it.
      try {
        const check = currentFraudCheck();
        if (check?.recordsBlockedAfterRollback) await check.recordBlocked?.(error.blocked);
      } catch {
        // the fraud module logs its own failures; a record that could not be written never changes the answer
      }
      // Exactly a decline: same status, code, message and details — no fraud wording, no distinct code.
      throw new AppError('payment_failed', 'payment not authorized', {
        provider: error.blocked.paymentProvider,
      });
    }
    if (!(error instanceof PriceChangedSignal)) throw error;
    // The placement transaction is gone (nothing placed, nothing authorized, no promotion use counted). Persist
    // the new prices and the new discount in a transaction of their own so the storefront reads them, then answer
    // 409 `price_changed` (#228): the customer never pays an amount they did not see.
    const before = error.quoted;
    const after = await client.transaction(async (tx) => {
      const cart = await lockActiveCart(tx, input.cartId);
      await repriceLines(tx, cart, { at: error.at });
      await recalculate(tx, cart, { at: error.at });
      return quotedAmounts(await loadCart(tx, input.cartId, false));
    });
    throw new AppError('price_changed', 'One or more prices changed', {
      currency: error.currency,
      items: error.changes.map((c) => ({
        line_item_id: c.lineItemId,
        variant_id: c.variantId,
        previous_unit_price_minor: c.previousUnitPriceMinor,
        unit_price_minor: c.unitPriceMinor,
      })),
      // a promotion that ended, started, ran out or changed since the cart was quoted (#230): same rule, same code
      ...(before.discount !== after.discount
        ? { discount_minor: { previous: before.discount, current: after.discount } }
        : {}),
      ...(before.shipping !== after.shipping
        ? { shipping_minor: { previous: before.shipping, current: after.shipping } }
        : {}),
      total_minor: { previous: before.total, current: after.total },
    });
  }
}

interface QuotedAmounts {
  discount: number;
  shipping: number;
  total: number;
}

/** What the customer last saw on the cart: the amounts a placement must not change silently. */
const quotedAmounts = (cart: CartRow): QuotedAmounts => ({
  discount: Number(cart.discount_minor),
  shipping: Number(cart.shipping_minor),
  total: Number(cart.total_minor),
});

/** Thrown inside the placement transaction on a fraud `block`; `completeCart` records it after the rollback. */
class FraudBlockedSignal extends Error {
  constructor(readonly blocked: BlockedPlacement) {
    super('fraud block');
  }
}

/** Thrown inside the placement transaction to roll it back; `completeCart` turns it into the 409. */
class PriceChangedSignal extends Error {
  constructor(
    readonly changes: PriceChange[],
    readonly currency: string,
    readonly at: Date,
    /** The cart's amounts as the customer last saw them (before this placement re-priced anything). */
    readonly quoted: QuotedAmounts,
  ) {
    super('price changed');
  }
}

async function placeOrder(
  client: ScopedClient,
  input: CompleteCartInput,
): Promise<CompleteCartResult> {
  const { cartId, idempotencyKey } = input;
  const at = new Date(); // one clock for every price window judged by this placement
  return client.transaction(async (tx) => {
    // ---- replay ---- Keys are per store: `payment.idempotency_key` is UNIQUE table-wide (0006) while RLS hides
    // other stores' rows from this lookup, so the stored value is `<store_id>:<Idempotency-Key>` — the same key
    // sent to two stores places two orders and never collides or replays across stores (README "Idempotency").
    const cartStore = await tx.query<{ store_id: string }>(
      `SELECT store_id FROM cart WHERE id = $1`,
      [cartId],
    );
    if (!cartStore.rows[0]) throw notFound('cart', cartId);
    const storedKey = `${cartStore.rows[0].store_id}:${idempotencyKey}`;
    const replay = await tx.query<{ order_id: string; cart_id: string | null }>(
      `SELECT p.order_id, o.cart_id FROM payment p JOIN "order" o ON o.id = p.order_id WHERE p.idempotency_key = $1`,
      [storedKey],
    );
    const prior = replay.rows[0];
    if (prior) {
      if (prior.cart_id !== cartId) {
        throw new AppError('conflict', 'Idempotency-Key was already used for another cart', {
          'Idempotency-Key': 'reuse across carts',
        });
      }
      return { order: await renderStoreOrder(tx, prior.order_id), replayed: true };
    }

    // ---- lock + preconditions ----
    const locked = await lockActiveCart(tx, cartId); // 409 cart_completed carries the order id
    let lines = await loadLines(tx, cartId);
    const missing: Record<string, string> = {};
    if (lines.length === 0) missing.items = 'cart is empty';
    if (!locked.email?.trim()) missing.email = 'required';
    if (!locked.shipping_address) missing.shipping_address = 'required';
    if (!locked.billing_address) missing.billing_address = 'required';
    if (!locked.shipping_option_id) missing.shipping_option_id = 'required';
    if (!locked.payment_session) missing.payment_session = 'create one with POST …/payment-session';
    if (Object.keys(missing).length)
      throw validationError('cart is not ready for checkout', missing);

    // Prices as of now (sale ended, tier or group list changed since the cart was priced): never place silently.
    const priceChanges = await repriceLines(tx, locked, { at, apply: false });
    const quoted = quotedAmounts(locked);
    if (priceChanges.length > 0) {
      throw new PriceChangedSignal(priceChanges, locked.currency, at, quoted);
    }

    // Discounts, shipping and tax as of the placement clock (#230 PR B): promotions are re-evaluated under the cart
    // lock. A discount or a free-shipping grant that is no longer what the customer saw is the same case as a
    // changed price — never placed silently.
    const discounts = await recalculate(tx, locked, { explicitShippingOption: true, at });
    const cart = await loadCart(tx, cartId, false);
    const requoted = quotedAmounts(cart);
    const freeShippingChanged =
      requoted.shipping !== quoted.shipping && (discounts.freeShipping || quoted.shipping === 0);
    if (requoted.discount !== quoted.discount || freeShippingChanged) {
      throw new PriceChangedSignal([], locked.currency, at, quoted);
    }
    lines = await loadLines(tx, cartId); // as just priced: rate + metadata.tax are what the order freezes (#221)
    if (!cart.shipping_option_id) {
      throw validationError('cart is not ready for checkout', {
        shipping_option_id: 'no longer available for this destination',
      });
    }
    // Stock is checked by the reservation below, under the level rows' locks (inventory module, task 2.4).

    // ---- payment ----
    const session = cart.payment_session!;
    const provider = paymentProvider(session.provider);
    if (!provider) {
      throw validationError(`payment provider ${session.provider} is not available`, {
        payment_session: 'provider not available; create a new session',
      });
    }
    // ---- fraud (#231): BEFORE any authorisation. `block` answers exactly like a decline — same status, code,
    // message and details; no fraud wording, no distinct code (it would be an oracle for a probing fraudster).
    // Nothing was written and nothing was authorised, so there is nothing to void; the fraud module records the
    // real reason in its own transaction. `review` places the order and flags it below.
    const fraudFacts = {
      organizationId: cart.organization_id,
      storeId: cart.store_id,
      cartId,
      amountMinor: Number(cart.total_minor),
      currency: cart.currency,
      emailHash: emailHash(cart.email!), // emailHash trims and lowercases itself
      shippingCountry: cart.shipping_address?.country ?? null,
      billingCountry: cart.billing_address?.country ?? null,
      paymentProvider: provider.name,
      providerSessionId: session.session_id ?? null,
      actor: input.actor,
    };
    const fraud = await evaluateFraud({ tx, ...fraudFacts });
    if (fraud.outcome === 'block') throw new FraudBlockedSignal({ ...fraudFacts, decision: fraud });

    // ---- promotion uses (#230 PR B): inside the placement transaction and BEFORE any authorisation. A lost race on
    // a promotion's last use is a 409 `conflict` from the evaluator; nothing was authorised, so nothing to void,
    // and the rollback takes every counted use back — a failed placement never burns one.
    const evaluator = currentDiscountEvaluator();
    for (const applied of discounts.applied) {
      await evaluator.recordUse?.(tx, cart.store_id, applied.promotionId);
    }

    const auth = await provider.authorize({ tx, cart: cartRef(cart), session, idempotencyKey });
    if (auth.status !== 'authorized' || !auth.providerPaymentId) {
      throw new AppError('payment_failed', auth.failureReason ?? 'payment not authorized', {
        provider: provider.name,
      });
    }

    // Everything after a successful authorisation runs under a guard: any throw (out_of_stock from the
    // reservation, a shipping-option race, a database error) rolls the transaction back, and the provider's
    // authorisation is voided before rethrowing so no dangling hold survives (Stripe depends on it; #174 review).
    try {
      // ---- order ----
      const option = await tx.query<{ code: string; name: string; carrier: string }>(
        `SELECT code, name, carrier FROM shipping_option WHERE id = $1`,
        [cart.shipping_option_id],
      );
      const optionRow = option.rows[0];
      if (!optionRow) {
        throw validationError('cart is not ready for checkout', {
          shipping_option_id: 'unknown shipping option',
        });
      }
      const shippingMethod = {
        code: optionRow.code,
        name: optionRow.name,
        carrier: optionRow.carrier,
        price_minor: Number(cart.shipping_minor),
      };
      const email = cart.email!.trim();
      // The order's metadata starts as the storefront's cart metadata — minus the keys that are OURS on an
      // order: a storefront must not be able to pre-write a fraud review or applied promotions.
      const metadata = orderMetadataFromCart(cart.metadata);
      for (const reserved of RESERVED_ORDER_METADATA_KEYS) delete metadata[reserved];
      // Applied promotions, frozen (#230 PR B): what per-customer limits count later; codes = the APPLIED ones only.
      const appliedCodes = discounts.applied.flatMap((p) => (p.code ? [p.code] : []));
      if (discounts.applied.length > 0) {
        metadata.promotions = discounts.applied.map((p) => ({
          promotion_id: p.promotionId,
          code: p.code,
          discount_minor: p.discountMinor,
        }));
      }
      const inserted = await tx.query<OrderInsertRow>(
        `INSERT INTO "order" (organization_id, store_id, sales_channel_id, cart_id, customer_id, email, currency, locale,
         status, payment_status, shipping_address, billing_address, shipping_option_id, shipping_method,
         promotion_codes, subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'authorized', $9::jsonb, $10::jsonb, $11, $12::jsonb,
         $13, $14, $15, $16, $17, $18, $19::jsonb)
       RETURNING id, display_id::text, placed_at`,
        [
          cart.organization_id,
          cart.store_id,
          cart.sales_channel_id,
          cart.id,
          cart.customer_id,
          email,
          cart.currency,
          cart.locale,
          JSON.stringify(cart.shipping_address),
          JSON.stringify(cart.billing_address),
          cart.shipping_option_id,
          JSON.stringify(shippingMethod),
          appliedCodes,
          cart.subtotal_minor,
          cart.discount_minor,
          cart.shipping_minor,
          cart.tax_minor,
          cart.total_minor,
          JSON.stringify(metadata),
        ],
      );
      const order = inserted.rows[0]!;

      const orderLines: LineInsertRow[] = [];
      for (const l of lines) {
        const unit = Number(l.unit_price_minor);
        const discount = Number(l.discount_minor);
        const base = l.quantity * unit - discount;
        // the calculator's own per-line amount and mode, frozen — never recomputed from the rate (#221); the
        // record travels on in the order line's metadata so an order edit re-prices in the same mode
        const tax = lineTaxOf(l);
        const r = await tx.query<LineInsertRow>(
          `INSERT INTO order_line_item (organization_id, store_id, order_id, variant_id, sku, title, variant_title,
           thumbnail_url, quantity, unit_price_minor, discount_minor, tax_rate_bp, tax_minor, total_minor, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
         RETURNING id, variant_id, sku, title, quantity, unit_price_minor::text, discount_minor::text, tax_rate_bp,
           tax_minor::text, total_minor::text`,
          [
            cart.organization_id,
            cart.store_id,
            order.id,
            l.variant_id,
            l.sku,
            l.title,
            l.variant_title,
            l.thumbnail_url,
            l.quantity,
            unit,
            discount,
            l.tax_rate_bp,
            tax.amount_minor,
            lineTotalWith(base, tax),
            JSON.stringify(l.metadata ?? {}),
          ],
        );
        orderLines.push(r.rows[0]!);
      }

      // ---- reservations: the stock check at placement (409 out_of_stock → whole placement rolls back) ----
      await reserveForOrder(tx, {
        organizationId: cart.organization_id,
        storeId: cart.store_id,
        orderId: order.id,
        lines: orderLines
          .filter((l) => l.variant_id !== null)
          .map((l) => ({ variantId: l.variant_id!, quantity: l.quantity })),
      });

      const fraudFlag =
        fraud.outcome === 'review'
          ? {
              status: 'review' as const,
              // a review without a code or provider is a malformed answer: booked as an outage, so both
              // values stay inside the fraud module's closed sets (#236 review)
              reason_code: fraud.reasonCode ?? FRAUD_CHECK_UNAVAILABLE,
              provider: fraud.provider ?? FRAUD_OUTAGE_PROVIDER,
              flagged_at: at.toISOString(),
            }
          : null;
      // ---- payment row (the one money movement; carries the Idempotency-Key) ----
      const paymentRow = await tx.query<{ id: string; authorized_at: Date }>(
        `INSERT INTO payment (organization_id, store_id, order_id, provider, provider_payment_id, amount_minor, currency,
         status, authorized_at, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'authorized', now(), $8, $9::jsonb) RETURNING id, authorized_at`,
        [
          cart.organization_id,
          cart.store_id,
          order.id,
          provider.name,
          auth.providerPaymentId,
          cart.total_minor,
          cart.currency,
          storedKey,
          // the payment row is the source of truth of a fraud review (window 7's aggregate); the order carries
          // the mirror written by the orders module right below
          JSON.stringify({
            session_id: session.session_id,
            ...(fraudFlag ? { fraud: fraudFlag } : {}),
          }),
        ],
      );
      if (fraudFlag) {
        await flagOrderForReview(tx, order.id, {
          reasonCode: fraudFlag.reason_code,
          provider: fraudFlag.provider,
          flaggedAt: fraudFlag.flagged_at,
          actor: input.actor,
        });
      }

      // ---- attribution (Integration 1 helper) + order.placed ----
      await recordAttribution(tx, {
        organizationId: cart.organization_id,
        storeId: cart.store_id,
        orderId: order.id,
        cartId: cart.id,
        cartMetadata: cart.metadata,
        actor: input.actor,
      });
      const legal = await tx.query<{ legal_entity_id: string }>(
        `SELECT legal_entity_id FROM store WHERE id = $1`,
        [cart.store_id],
      );
      const paymentId = paymentRow.rows[0]!.id;
      await withEvents(tx, [
        // #176 (window 7): the payment row is created here, so only this transaction can emit its baseline event.
        await buildEvent({
          topic: 'payment.authorized',
          organizationId: cart.organization_id,
          storeId: cart.store_id,
          aggregateType: 'payment',
          aggregateId: paymentId,
          actor: eventActor(input.actor),
          payload: {
            payment_id: paymentId,
            order_id: order.id,
            legal_entity_id: legal.rows[0]!.legal_entity_id,
            provider: provider.name,
            provider_payment_id: auth.providerPaymentId,
            amount_minor: Number(cart.total_minor),
            currency: cart.currency,
            authorized_at: paymentRow.rows[0]!.authorized_at.toISOString(),
          },
        }),
        await buildEvent({
          topic: 'order.placed',
          organizationId: cart.organization_id,
          storeId: cart.store_id,
          aggregateType: 'order',
          aggregateId: order.id,
          actor: eventActor(input.actor),
          payload: {
            order_id: order.id,
            display_id: Number(order.display_id),
            legal_entity_id: legal.rows[0]!.legal_entity_id,
            sales_channel_id: cart.sales_channel_id,
            customer_id: cart.customer_id,
            email_hash: emailHash(email),
            currency: cart.currency,
            locale: cart.locale,
            totals: {
              subtotal_minor: Number(cart.subtotal_minor),
              discount_minor: Number(cart.discount_minor),
              shipping_minor: Number(cart.shipping_minor),
              tax_minor: Number(cart.tax_minor),
              total_minor: Number(cart.total_minor),
            },
            line_items: orderLines.map((l) => ({
              order_line_item_id: l.id,
              variant_id: l.variant_id,
              sku: l.sku,
              title: l.title,
              quantity: l.quantity,
              unit_price_minor: Number(l.unit_price_minor),
              discount_minor: Number(l.discount_minor),
              tax_rate_bp: l.tax_rate_bp,
              tax_minor: Number(l.tax_minor),
              total_minor: Number(l.total_minor),
            })),
            shipping: { shipping_option_id: cart.shipping_option_id, ...shippingMethod },
            shipping_country: cart.shipping_address!.country,
            billing_country: cart.billing_address!.country,
            promotion_codes: appliedCodes,
            placed_at: order.placed_at.toISOString(),
          },
        }),
      ]);
      if (input.hooks?.afterEvents) await input.hooks.afterEvents(tx);

      // ---- cart completed ----
      await tx.query(
        `UPDATE cart SET status = 'completed', order_id = $2, completed_at = now(),
         payment_session = $3::jsonb, updated_at = now() WHERE id = $1`,
        [cartId, order.id, JSON.stringify({ ...session, status: 'authorized' })],
      );
      return { order: await renderStoreOrder(tx, order.id), replayed: false };
    } catch (err) {
      await provider
        .void({
          tx, // being rolled back — the provider must resolve everything from the fields below
          organizationId: cart.organization_id,
          storeId: cart.store_id,
          cartId: cart.id,
          providerPaymentId: auth.providerPaymentId,
          idempotencyKey: `${idempotencyKey}:void`,
          reason: 'placement failed',
        })
        .catch(() => undefined); // the original error is what the caller must see
      throw err;
    }
  });
}

/** 404 unless the cart is visible; used by routes that only need existence (e.g. before listing options). */
export async function assertCartVisible(client: ScopedClient, cartId: string): Promise<void> {
  const r = await client.query<{ id: string }>(`SELECT id FROM cart WHERE id = $1`, [cartId]);
  if (!r.rows[0]) throw notFound('cart', cartId);
}
