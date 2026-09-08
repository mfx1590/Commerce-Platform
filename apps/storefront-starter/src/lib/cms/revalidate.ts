import { createHmac, timingSafeEqual } from 'node:crypto';
import { DOCUMENT_TYPES } from '@platform/cms';
import { cmsTags } from './tags';

/**
 * Revalidate-on-publish. Sanity calls `POST /api/cms/revalidate` on publish/unpublish with the
 * document's projection and a signature header:
 *
 *   sanity-webhook-signature: t=<unix ms>,v1=<base64url HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The webhook is configured with the projection `{ _id, _type, locale, "slug": slug.current, key }`
 * (cms/README.md); anything else still revalidates the `cms` tag, so an unknown type can never
 * leave stale content behind.
 */

export const SIGNATURE_HEADER = 'sanity-webhook-signature';
/** Sanity's own default: a signature older than five minutes is a replay. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export type SignatureVerdict =
  { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' };

export function signWebhook(secret: string, timestamp: number, body: string): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('base64url');
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(
  secret: string,
  header: string | null,
  body: string,
  now: number = Date.now(),
  toleranceMs: number = SIGNATURE_TOLERANCE_MS,
): SignatureVerdict {
  if (!header) return { ok: false, reason: 'missing' };
  const match = /^t=(\d+),v1=([A-Za-z0-9_-]+)$/.exec(header.trim());
  if (!match) return { ok: false, reason: 'malformed' };
  const timestamp = Number(match[1]);
  if (Math.abs(now - timestamp) > toleranceMs) return { ok: false, reason: 'expired' };
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const given = Buffer.from(`t=${timestamp},v1=${match[2]}`);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

export interface WebhookPayload {
  _id?: string;
  _type?: string;
  locale?: string;
  slug?: string | { current?: string };
  key?: string;
}

export function parseWebhookPayload(body: string): WebhookPayload | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as WebhookPayload) : null;
  } catch {
    return null;
  }
}

/** The tags a publish should drop: always `cms`; the type and the document when they are known. */
export function tagsForWebhook(payload: WebhookPayload | null): string[] {
  const tags: string[] = [cmsTags.all];
  const type = payload?._type;
  if (!type || !(DOCUMENT_TYPES as readonly string[]).includes(type)) return tags;
  tags.push(cmsTags.type(type));
  const slug = typeof payload.slug === 'string' ? payload.slug : payload.slug?.current;
  const slugOrKey = slug ?? payload.key;
  if (payload.locale && slugOrKey) tags.push(cmsTags.document(type, payload.locale, slugOrKey));
  return tags;
}
