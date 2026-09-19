// In-memory StripeApi for tests: an idempotency map (same key → the recorded response, no second object), a call
// log (the "recorded fixture" the acceptance criteria ask to assert on), and scriptable declines. Mimics the
// slices of Stripe behaviour the module relies on: manual-capture intents, client-side confirmation via the
// Payment Element (simulated with `clientConfirm`), decline → 402 + `last_payment_error`, capture fees.
import { randomUUID } from 'node:crypto';
import {
  StripeError,
  type StripeApi,
  type StripeChargeOutcome,
  type StripeParams,
  type StripePaymentIntent,
  type StripeRefund,
  type StripeRequestOptions,
  type StripeTaxCalculation,
  type StripeTaxLineItem,
} from './stripe-client';

export interface FakeCall {
  method: string;
  id?: string;
  params: StripeParams;
  idempotencyKey?: string | undefined;
  expand?: string[] | undefined;
}

interface FakeIntent extends StripePaymentIntent {
  capture_method: 'automatic' | 'manual';
}

export class FakeStripe implements StripeApi {
  readonly calls: FakeCall[] = [];
  readonly intents = new Map<string, FakeIntent>();
  readonly refunds = new Map<string, StripeRefund>();
  private readonly recorded = new Map<string, string>(); // idempotency key → object id
  /** Fee the fake charges on capture (minor units); asserted as `payment.fee_minor`. */
  captureFee = 123;
  /** Script the next refund to be accepted but not settled: Stripe answers `pending` (then reset). */
  pendingNextRefund = false;
  /** Script the next confirm to decline with this code (then reset). */
  declineNextConfirm: string | null = null;
  /** Script the next capture to fail definitively (then reset). */
  failNextCapture: string | null = null;
  /** Script the next capture to fail with a retryable 500 (then reset). */
  outageNextCapture = false;
  /** Script the next refund to fail (then reset). */
  failNextRefund: string | null = null;
  /** Script the next cancel to fail with a retryable 500 (then reset). */
  outageNextCancel = false;
  /** Stripe Tax: the rate the fake applies to every line and to shipping, in basis points. */
  taxRateBp = 2100;
  /** Script the next tax calculation to fail with a retryable 500 (then reset). */
  outageNextTax = false;
  /** Script the next tax calculation to be refused definitively with this code (then reset). */
  failNextTax: string | null = null;

  private log(call: FakeCall): void {
    this.calls.push(call);
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private replay<T>(key: string | undefined, lookup: (id: string) => T | undefined): T | undefined {
    if (!key) return undefined;
    const id = this.recorded.get(key);
    return id === undefined ? undefined : lookup(id);
  }

  private intent(id: string): FakeIntent {
    const i = this.intents.get(id);
    if (!i) throw new StripeError(404, `No such payment_intent: '${id}'`, 'invalid_request_error');
    return i;
  }

  async createPaymentIntent(
    params: StripeParams,
    opts: StripeRequestOptions = {},
  ): Promise<StripePaymentIntent> {
    this.log({ method: 'createPaymentIntent', params, idempotencyKey: opts.idempotencyKey });
    const replayed = this.replay(opts.idempotencyKey, (id) => this.intents.get(id));
    if (replayed) return replayed;
    const id = `pi_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const intent: FakeIntent = {
      id,
      object: 'payment_intent',
      status: 'requires_payment_method',
      amount: Number(params.amount),
      currency: String(params.currency),
      client_secret: `${id}_secret_fake`,
      capture_method: (params.capture_method as 'manual' | undefined) ?? 'automatic',
      metadata: (params.metadata as Record<string, string> | undefined) ?? {},
    };
    this.intents.set(id, intent);
    if (opts.idempotencyKey) this.recorded.set(opts.idempotencyKey, id);
    return intent;
  }

  async updatePaymentIntent(
    id: string,
    params: StripeParams,
    opts: StripeRequestOptions = {},
  ): Promise<StripePaymentIntent> {
    this.log({ method: 'updatePaymentIntent', id, params, idempotencyKey: opts.idempotencyKey });
    const intent = this.intent(id);
    if (!['requires_payment_method', 'requires_confirmation'].includes(intent.status)) {
      throw new StripeError(
        400,
        `You cannot update a PaymentIntent in status ${intent.status}`,
        'invalid_request_error',
        'payment_intent_unexpected_state',
      );
    }
    if (params.amount !== undefined) intent.amount = Number(params.amount);
    if (params.currency !== undefined) intent.currency = String(params.currency);
    return intent;
  }

  async retrievePaymentIntent(
    id: string,
    opts: StripeRequestOptions = {},
  ): Promise<StripePaymentIntent> {
    this.log({ method: 'retrievePaymentIntent', id, params: {}, expand: opts.expand });
    if (this.outageNextRetrieve) {
      this.outageNextRetrieve = false;
      throw new StripeError(500, 'Something went wrong on Stripe’s end', 'api_error');
    }
    return this.intent(id);
  }

  /** The storefront's Payment Element confirmed with a test card: manual capture → `requires_capture`. */
  clientConfirm(id: string): void {
    const intent = this.intent(id);
    intent.status = intent.capture_method === 'manual' ? 'requires_capture' : 'succeeded';
  }

  /** Radar's verdict on the intent's latest charge (what `expand[]=latest_charge` returns). */
  setRadarOutcome(id: string, outcome: StripeChargeOutcome): void {
    const intent = this.intent(id);
    const existing = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    intent.latest_charge = {
      id: existing?.id ?? `ch_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      ...(existing ?? {}),
      outcome,
    };
  }

  /** Script the next retrieve to fail with a retryable 500 (then reset). */
  outageNextRetrieve = false;

  /** Attach a payment method without confirming (server-side confirm path). */
  attachPaymentMethod(id: string): void {
    this.intent(id).status = 'requires_confirmation';
  }

  async confirmPaymentIntent(
    id: string,
    params: StripeParams,
    opts: StripeRequestOptions = {},
  ): Promise<StripePaymentIntent> {
    this.log({ method: 'confirmPaymentIntent', id, params, idempotencyKey: opts.idempotencyKey });
    const replayed = this.replay(opts.idempotencyKey, (rid) => this.intents.get(rid));
    if (replayed) return replayed;
    const intent = this.intent(id);
    if (this.declineNextConfirm) {
      const decline = this.declineNextConfirm;
      this.declineNextConfirm = null;
      intent.status = 'requires_payment_method';
      intent.last_payment_error = {
        code: 'card_declined',
        decline_code: decline,
        message: 'Your card was declined.',
      };
      throw new StripeError(402, 'Your card was declined.', 'card_error', 'card_declined', decline);
    }
    if (!['requires_confirmation', 'requires_payment_method'].includes(intent.status)) {
      throw new StripeError(
        400,
        `You cannot confirm a PaymentIntent in status ${intent.status}`,
        'invalid_request_error',
        'payment_intent_unexpected_state',
      );
    }
    intent.status = intent.capture_method === 'manual' ? 'requires_capture' : 'succeeded';
    intent.last_payment_error = null;
    if (opts.idempotencyKey) this.recorded.set(opts.idempotencyKey, id);
    return intent;
  }

  async capturePaymentIntent(
    id: string,
    params: StripeParams,
    opts: StripeRequestOptions = {},
  ): Promise<StripePaymentIntent> {
    this.log({
      method: 'capturePaymentIntent',
      id,
      params,
      idempotencyKey: opts.idempotencyKey,
      expand: opts.expand,
    });
    const replayed = this.replay(opts.idempotencyKey, (rid) => this.intents.get(rid));
    if (replayed) return replayed;
    if (this.outageNextCapture) {
      this.outageNextCapture = false;
      throw new StripeError(500, 'Something went wrong on Stripe’s end', 'api_error');
    }
    const intent = this.intent(id);
    if (this.failNextCapture) {
      const code = this.failNextCapture;
      this.failNextCapture = null;
      throw new StripeError(402, 'The capture failed.', 'card_error', code);
    }
    if (intent.status !== 'requires_capture') {
      throw new StripeError(
        400,
        `You cannot capture a PaymentIntent in status ${intent.status}`,
        'invalid_request_error',
        'payment_intent_unexpected_state',
      );
    }
    intent.status = 'succeeded';
    intent.latest_charge = {
      id: `ch_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      balance_transaction: { id: `txn_${randomUUID().slice(0, 8)}`, fee: this.captureFee },
    };
    if (opts.idempotencyKey) this.recorded.set(opts.idempotencyKey, id);
    return intent;
  }

  /**
   * Like Stripe: a replay of the same idempotency key returns the recorded response, but cancelling an intent
   * that is already `canceled` (or already captured → `succeeded`) with a *fresh* key is a definitive
   * `invalid_request_error` / `payment_intent_unexpected_state`, not a silent success.
   */
  async cancelPaymentIntent(
    id: string,
    opts: StripeRequestOptions = {},
  ): Promise<StripePaymentIntent> {
    this.log({
      method: 'cancelPaymentIntent',
      id,
      params: {},
      idempotencyKey: opts.idempotencyKey,
    });
    const replayed = this.replay(opts.idempotencyKey, (rid) => this.intents.get(rid));
    if (replayed) return replayed;
    if (this.outageNextCancel) {
      this.outageNextCancel = false;
      throw new StripeError(500, 'Something went wrong on Stripe’s end', 'api_error');
    }
    const intent = this.intent(id);
    if (intent.status === 'canceled' || intent.status === 'succeeded') {
      throw new StripeError(
        400,
        `You cannot cancel this PaymentIntent because it has a status of ${intent.status}.`,
        'invalid_request_error',
        'payment_intent_unexpected_state',
      );
    }
    intent.status = 'canceled';
    if (opts.idempotencyKey) this.recorded.set(opts.idempotencyKey, id);
    return intent;
  }

  async createRefund(params: StripeParams, opts: StripeRequestOptions = {}): Promise<StripeRefund> {
    this.log({ method: 'createRefund', params, idempotencyKey: opts.idempotencyKey });
    const replayed = this.replay(opts.idempotencyKey, (id) => this.refunds.get(id));
    if (replayed) return replayed;
    if (this.failNextRefund) {
      const code = this.failNextRefund;
      this.failNextRefund = null;
      throw new StripeError(402, 'The refund failed.', 'card_error', code);
    }
    const intent = this.intent(String(params.payment_intent));
    const pending = this.pendingNextRefund;
    this.pendingNextRefund = false;
    const refund: StripeRefund = {
      id: `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      object: 'refund',
      status: pending ? 'pending' : 'succeeded',
      amount: params.amount === undefined ? intent.amount : Number(params.amount),
      currency: intent.currency,
    };
    this.refunds.set(refund.id, refund);
    if (opts.idempotencyKey) this.recorded.set(opts.idempotencyKey, refund.id);
    return refund;
  }

  /**
   * Stripe Tax: `taxRateBp` on every line and on shipping, with the platform's single rounding rule (the tax
   * rounded half-up; exclusive on top, inclusive contained) so fake results equal the table provider's.
   */
  async createTaxCalculation(
    params: StripeParams,
    opts: StripeRequestOptions = {},
  ): Promise<StripeTaxCalculation> {
    this.log({ method: 'createTaxCalculation', params, expand: opts.expand });
    if (this.outageNextTax) {
      this.outageNextTax = false;
      throw new StripeError(500, 'Something went wrong on Stripe’s end', 'api_error');
    }
    if (this.failNextTax) {
      const code = this.failNextTax;
      this.failNextTax = null;
      throw new StripeError(400, 'The tax location is invalid.', 'invalid_request_error', code);
    }
    const bp = this.taxRateBp;
    // The platform's single rounding rule (the cart module's `taxOn`): the TAX rounded half-up —
    // on top = amount × bp / 10000, contained = amount × bp / (10000 + bp).
    const taxOf = (amount: number, behavior: string): number => {
      const divisor = behavior === 'inclusive' ? 10000 + bp : 10000;
      return amount <= 0 || bp <= 0 ? 0 : Math.floor((2 * amount * bp + divisor) / (2 * divisor));
    };
    const items = (params.line_items as Record<string, unknown>[] | undefined) ?? [];
    const data: StripeTaxLineItem[] = items.map((i) => {
      const amount = Number(i.amount);
      const behavior = String(i.tax_behavior ?? 'exclusive') as 'inclusive' | 'exclusive';
      const tax = taxOf(amount, behavior);
      return {
        reference: String(i.reference),
        amount,
        amount_tax: tax,
        tax_behavior: behavior,
        tax_breakdown: [
          { amount: tax, tax_rate_details: { percentage_decimal: (bp / 100).toString() } },
        ],
      };
    });
    const ship = params.shipping_cost as Record<string, unknown> | undefined;
    const shipping = ship
      ? {
          amount: Number(ship.amount),
          amount_tax: taxOf(Number(ship.amount), String(ship.tax_behavior ?? 'exclusive')),
        }
      : null;
    const exclusive =
      data.filter((d) => d.tax_behavior === 'exclusive').reduce((n, d) => n + d.amount_tax, 0) +
      (ship && String(ship.tax_behavior ?? 'exclusive') === 'exclusive' ? shipping!.amount_tax : 0);
    const inclusive =
      data.reduce((n, d) => n + d.amount_tax, 0) + (shipping?.amount_tax ?? 0) - exclusive;
    return {
      id: `taxcalc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      object: 'tax.calculation',
      currency: String(params.currency),
      amount_total: data.reduce((n, d) => n + d.amount, 0) + (shipping?.amount ?? 0) + exclusive,
      tax_amount_exclusive: exclusive,
      tax_amount_inclusive: inclusive,
      line_items: { data },
      shipping_cost: shipping,
    };
  }
}
