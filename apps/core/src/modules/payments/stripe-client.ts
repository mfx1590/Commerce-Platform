// Thin Stripe REST client over Node's global fetch (no `stripe` npm dependency: apps/core/package.json belongs
// to window 1; same precedent as the search module's Algolia client). Only the endpoints the payments module
// needs, form-encoded the way Stripe expects, with the `Idempotency-Key` header and a pinned `Stripe-Version`.
// Card data NEVER passes through here (hosted fields / Payment Element, ADR 0004): amounts, ids and Stripe's own
// test payment-method tokens (`pm_card_visa`) only. Nothing here logs, and errors carry Stripe's error fields —
// never the raw response body and never a credential.

export const STRIPE_API_VERSION = '2024-06-20';
const BASE_URL = 'https://api.stripe.com';

export type StripeIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'succeeded'
  | 'canceled';

export interface StripeBalanceTransaction {
  id: string;
  /** Stripe's fee in the settlement currency's minor units. */
  fee: number;
}

export interface StripeCharge {
  id: string;
  balance_transaction?: string | StripeBalanceTransaction | null;
}

export interface StripeLastPaymentError {
  code?: string | null;
  decline_code?: string | null;
  message?: string | null;
}

export interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  status: StripeIntentStatus;
  amount: number;
  currency: string;
  client_secret: string | null;
  latest_charge?: string | StripeCharge | null;
  last_payment_error?: StripeLastPaymentError | null;
  metadata?: Record<string, string>;
}

export interface StripeRefund {
  id: string;
  object: 'refund';
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action';
  amount: number;
  currency: string;
  failure_reason?: string | null;
}

/** One line of a Stripe Tax calculation (`POST /v1/tax/calculations`, `expand[]=line_items`). */
export interface StripeTaxLineItem {
  /** Our reference (`cart_line_item.id`). */
  reference: string;
  amount: number;
  /** Tax on the line, integer minor units (Stripe rounds per line). */
  amount_tax: number;
  tax_behavior: 'inclusive' | 'exclusive';
  tax_breakdown?: {
    amount: number;
    tax_rate_details?: { percentage_decimal?: string | null } | null;
  }[];
}

export interface StripeTaxCalculation {
  id: string | null;
  object: 'tax.calculation';
  currency: string;
  amount_total: number;
  tax_amount_exclusive: number;
  tax_amount_inclusive: number;
  line_items?: { data: StripeTaxLineItem[] } | null;
  shipping_cost?: { amount: number; amount_tax: number } | null;
}

/** Params are flattened Stripe-style: `{ metadata: { cart_id: 'x' } }` → `metadata[cart_id]=x`. */
export type StripeParams = Record<string, unknown>;

export interface StripeRequestOptions {
  idempotencyKey?: string;
  expand?: string[];
}

/**
 * A non-2xx answer from Stripe. `message` is Stripe's own error message (card-safe by design: Stripe never puts
 * card numbers in it); the raw body is never attached.
 */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string | null = null,
    readonly code: string | null = null,
    readonly declineCode: string | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'StripeError';
  }

  /** Definitive rejection (card declined, bad request) vs a retryable outage (5xx / network / rate limit). */
  get definitive(): boolean {
    return this.status < 500 && this.status !== 429;
  }
}

/** What the payments module needs from Stripe; `FakeStripe` implements it for tests. */
export interface StripeApi {
  createPaymentIntent(
    params: StripeParams,
    opts?: StripeRequestOptions,
  ): Promise<StripePaymentIntent>;
  updatePaymentIntent(
    id: string,
    params: StripeParams,
    opts?: StripeRequestOptions,
  ): Promise<StripePaymentIntent>;
  retrievePaymentIntent(id: string, opts?: StripeRequestOptions): Promise<StripePaymentIntent>;
  confirmPaymentIntent(
    id: string,
    params: StripeParams,
    opts?: StripeRequestOptions,
  ): Promise<StripePaymentIntent>;
  capturePaymentIntent(
    id: string,
    params: StripeParams,
    opts?: StripeRequestOptions,
  ): Promise<StripePaymentIntent>;
  cancelPaymentIntent(id: string, opts?: StripeRequestOptions): Promise<StripePaymentIntent>;
  createRefund(params: StripeParams, opts?: StripeRequestOptions): Promise<StripeRefund>;
  /** Stripe Tax (task 2.4): amounts, ids and the destination address only. */
  createTaxCalculation(
    params: StripeParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeTaxCalculation>;
}

export interface StripeClientOptions {
  secretKey: string;
  /** Injectable for tests; default global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
  apiVersion?: string;
}

/** `{ a: { b: 1 }, c: ['x'] }` → `a[b]=1&c[0]=x` (Stripe's form encoding). Nullish values are skipped. */
export function formEncode(params: StripeParams): string {
  const pairs: string[] = [];
  const walk = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${key}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        walk(`${key}[${k}]`, v);
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return pairs.join('&');
}

export class StripeClient implements StripeApi {
  private readonly secretKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(opts: StripeClientOptions) {
    this.secretKey = opts.secretKey;
    this.fetchFn = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.apiVersion = opts.apiVersion ?? STRIPE_API_VERSION;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params: StripeParams = {},
    opts: StripeRequestOptions = {},
  ): Promise<T> {
    const all: StripeParams = { ...params, ...(opts.expand ? { expand: opts.expand } : {}) };
    const encoded = formEncode(all);
    const url =
      method === 'GET' && encoded ? `${this.baseUrl}${path}?${encoded}` : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Stripe-Version': this.apiVersion,
    };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await this.fetchFn(url, {
      method,
      headers,
      ...(method === 'POST' ? { body: encoded } : {}),
    });
    const requestId = res.headers.get('request-id');
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const err = (body as { error?: Record<string, unknown> } | undefined)?.error ?? {};
      throw new StripeError(
        res.status,
        typeof err.message === 'string' ? err.message : `stripe answered ${res.status}`,
        typeof err.type === 'string' ? err.type : null,
        typeof err.code === 'string' ? err.code : null,
        typeof err.decline_code === 'string' ? err.decline_code : null,
        requestId,
      );
    }
    return body as T;
  }

  createPaymentIntent(params: StripeParams, opts?: StripeRequestOptions) {
    return this.request<StripePaymentIntent>('POST', '/v1/payment_intents', params, opts);
  }

  updatePaymentIntent(id: string, params: StripeParams, opts?: StripeRequestOptions) {
    return this.request<StripePaymentIntent>('POST', `/v1/payment_intents/${id}`, params, opts);
  }

  retrievePaymentIntent(id: string, opts?: StripeRequestOptions) {
    return this.request<StripePaymentIntent>('GET', `/v1/payment_intents/${id}`, {}, opts);
  }

  confirmPaymentIntent(id: string, params: StripeParams, opts?: StripeRequestOptions) {
    return this.request<StripePaymentIntent>(
      'POST',
      `/v1/payment_intents/${id}/confirm`,
      params,
      opts,
    );
  }

  capturePaymentIntent(id: string, params: StripeParams, opts?: StripeRequestOptions) {
    return this.request<StripePaymentIntent>(
      'POST',
      `/v1/payment_intents/${id}/capture`,
      params,
      opts,
    );
  }

  cancelPaymentIntent(id: string, opts?: StripeRequestOptions) {
    return this.request<StripePaymentIntent>('POST', `/v1/payment_intents/${id}/cancel`, {}, opts);
  }

  createRefund(params: StripeParams, opts?: StripeRequestOptions) {
    return this.request<StripeRefund>('POST', '/v1/refunds', params, opts);
  }

  createTaxCalculation(params: StripeParams, opts?: StripeRequestOptions) {
    return this.request<StripeTaxCalculation>('POST', '/v1/tax/calculations', params, opts);
  }
}
