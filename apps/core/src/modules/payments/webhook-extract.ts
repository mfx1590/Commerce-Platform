// The REDACTED extract of a Stripe event (task 2.2, #125): what `webhook_event.payload` stores and what the
// replay CLI reprocesses. A Stripe event body carries billing details, receipt emails, shipping addresses and
// descriptions; none of that is needed to move a payment and none of it may be stored (#187, window 8's and
// our own requirement). The extract keeps ids, amounts, statuses and Stripe's error codes — nothing else — and
// is SEALED to `payload_hash` (sha256 of the raw body): replaying an extract that was edited, or whose
// `payload_hash` was edited, is refused.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface ExtractObject {
  id: string;
  object: string;
  status: string | null;
  amount: number | null;
  amount_received: number | null;
  amount_capturable: number | null;
  currency: string | null;
  /** For charges and refunds: the PaymentIntent they belong to (id only). */
  payment_intent: string | null;
  /** For PaymentIntents: the latest charge id (never the expanded object). */
  latest_charge: string | null;
  canceled_at: number | null;
  cancellation_reason: string | null;
  last_payment_error: { code: string | null; decline_code: string | null } | null;
  /** Refund objects: Stripe's failure code (`lost_or_stolen_card`, …) — a code, never free text. */
  failure_reason: string | null;
  /** Only the ids we put there at session creation. */
  metadata: { cart_id?: string; store_id?: string; organization_id?: string };
}

export interface WebhookExtract {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  api_version: string | null;
  request: { id: string | null; idempotency_key: string | null } | null;
  object: ExtractObject;
  /** Integrity seal over the extract and the raw-body hash; see `sealExtract`. */
  seal?: string;
}

const ALLOWED_METADATA = ['cart_id', 'store_id', 'organization_id'] as const;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}

export class MalformedEventError extends Error {
  constructor(readonly reason: string) {
    super(`malformed stripe event: ${reason}`);
    this.name = 'MalformedEventError';
  }
}

/** The redacted extract of a parsed Stripe event body. Throws `MalformedEventError` (→ 400) on a non-event. */
export function redactStripeEvent(event: unknown): WebhookExtract {
  if (!event || typeof event !== 'object') throw new MalformedEventError('not an object');
  const e = event as Record<string, unknown>;
  if (e.object !== 'event') throw new MalformedEventError('object is not "event"');
  if (typeof e.id !== 'string' || !e.id.startsWith('evt_'))
    throw new MalformedEventError('missing id');
  if (typeof e.type !== 'string' || e.type.length === 0)
    throw new MalformedEventError('missing type');
  const data = e.data as { object?: unknown } | undefined;
  const o = data?.object;
  if (!o || typeof o !== 'object') throw new MalformedEventError('missing data.object');
  const obj = o as Record<string, unknown>;
  if (typeof obj.id !== 'string' || typeof obj.object !== 'string') {
    throw new MalformedEventError('data.object has no id/object');
  }
  const metadata: ExtractObject['metadata'] = {};
  const md = obj.metadata;
  if (md && typeof md === 'object') {
    for (const key of ALLOWED_METADATA) {
      const v = (md as Record<string, unknown>)[key];
      if (typeof v === 'string') metadata[key] = v;
    }
  }
  const lpe = obj.last_payment_error as Record<string, unknown> | null | undefined;
  const request = e.request as Record<string, unknown> | null | undefined;
  return {
    id: e.id,
    type: e.type,
    created: num(e.created) ?? 0,
    livemode: e.livemode === true,
    api_version: str(e.api_version),
    request:
      request && typeof request === 'object'
        ? { id: str(request.id), idempotency_key: str(request.idempotency_key) }
        : null,
    object: {
      id: obj.id,
      object: obj.object,
      status: str(obj.status),
      amount: num(obj.amount),
      amount_received: num(obj.amount_received),
      amount_capturable: num(obj.amount_capturable),
      currency: str(obj.currency),
      payment_intent: idOf(obj.payment_intent),
      latest_charge: idOf(obj.latest_charge),
      canceled_at: num(obj.canceled_at),
      cancellation_reason: str(obj.cancellation_reason),
      failure_reason: str(obj.failure_reason),
      last_payment_error:
        lpe && typeof lpe === 'object'
          ? { code: str(lpe.code), decline_code: str(lpe.decline_code) }
          : null,
      metadata,
    },
  };
}

/** Deterministic JSON (keys sorted at every level) so the seal does not depend on property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * `HMAC-SHA256(webhook secret, "<payload_hash>.<canonical extract without seal>")` — binds the extract to the raw
 * body it came from AND to the secret that authenticated that body: a row written by anyone without the
 * store's endpoint secret (a hand edit, a copy from another environment) cannot carry a valid seal, whereas a
 * plain hash could simply be recomputed by the editor.
 */
export function computeSeal(extract: WebhookExtract, payloadHash: string, secret: string): string {
  const { seal: _seal, ...rest } = extract;
  return createHmac('sha256', secret)
    .update(`${payloadHash}.${canonicalJson(rest)}`)
    .digest('hex');
}

export function sealExtract(
  extract: WebhookExtract,
  payloadHash: string,
  secret: string,
): WebhookExtract {
  return { ...extract, seal: computeSeal(extract, payloadHash, secret) };
}

/**
 * True when the stored extract still matches its stored `payload_hash` under one of the store's webhook
 * secrets (current first, then the previous one during a roll) — the replay precondition. Every candidate is
 * checked (no early exit) with a constant-time compare.
 */
export function verifySeal(
  extract: WebhookExtract,
  payloadHash: string,
  secrets: readonly string[],
): boolean {
  if (typeof extract.seal !== 'string' || extract.seal.length !== 64) return false;
  const given = Buffer.from(extract.seal, 'hex');
  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(computeSeal(extract, payloadHash, secret), 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = true;
  }
  return matched;
}
