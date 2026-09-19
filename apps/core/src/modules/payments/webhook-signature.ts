// Stripe webhook signatures (task 2.2, #125). Stripe signs `<timestamp>.<raw body>` with the endpoint secret
// (HMAC-SHA256, hex) and sends `Stripe-Signature: t=<ts>,v1=<sig>[,v1=<sig>…]`. During a secret roll Stripe
// signs with BOTH secrets for up to 24 h, so several `v1=` entries are normal and any one match is enough.
// Verification is over the RAW body bytes (a re-serialised JSON would not match) and constant-time. Nothing here
// logs, and the secret never leaves this module.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stripe's own default: a signature older than this is a replay, not a late delivery. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

export type SignatureVerdict =
  | { ok: true; timestamp: number }
  | {
      ok: false;
      reason:
        | 'missing_header'
        | 'malformed_header'
        | 'no_v1_signature'
        | 'timestamp_out_of_tolerance'
        | 'no_match';
    };

/** `t=…,v1=…,v1=…` → parts; null when the header is not in Stripe's shape. */
export function parseStripeSignature(header: string | undefined | null): ParsedSignature | null {
  if (!header) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1' && /^[0-9a-f]+$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
    // `v0` (test-mode scheme) and unknown keys are ignored, as Stripe's own libraries do.
  }
  if (timestamp === null) return null;
  return { timestamp, signatures };
}

/** The hex HMAC-SHA256 Stripe computes: `hmac(secret, "<timestamp>.<raw body>")`. */
export function computeStripeSignature(
  rawBody: Buffer | string,
  secret: string,
  timestamp: number,
): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

/** Builds a `Stripe-Signature` header value — what the Stripe CLI does; used by tests and the README. */
export function signStripePayload(
  rawBody: Buffer | string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${computeStripeSignature(rawBody, secret, timestamp)}`;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export interface VerifyOptions {
  rawBody: Buffer | string;
  header: string | undefined | null;
  /** The store's endpoint secret, or [current, previous] during a roll. */
  secret: string | readonly string[];
  toleranceSeconds?: number;
  /** Injectable clock (seconds since epoch) for tests. */
  nowSeconds?: number;
}

/**
 * Verifies a delivery: header shape, timestamp within tolerance (both directions — a clock skewed into the
 * future is as suspicious as a replay), then a constant-time compare of every `v1` entry against every secret.
 * The verdict carries a reason code (for the 400 body), never the body, a secret or a signature.
 */
export function verifyStripeSignature(opts: VerifyOptions): SignatureVerdict {
  const parsed = parseStripeSignature(opts.header);
  if (!opts.header) return { ok: false, reason: 'missing_header' };
  if (!parsed) return { ok: false, reason: 'malformed_header' };
  if (parsed.signatures.length === 0) return { ok: false, reason: 'no_v1_signature' };
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  const secrets = typeof opts.secret === 'string' ? [opts.secret] : opts.secret;
  // Check every candidate against every secret (no early exit) so timing does not reveal which one failed.
  let matched = false;
  for (const secret of secrets) {
    const expected = computeStripeSignature(opts.rawBody, secret, parsed.timestamp);
    for (const candidate of parsed.signatures) {
      if (constantTimeEqualHex(candidate, expected)) matched = true;
    }
  }
  return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: 'no_match' };
}
