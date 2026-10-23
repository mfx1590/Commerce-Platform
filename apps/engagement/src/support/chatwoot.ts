// The Chatwoot webhook receiver stub (#556).
//
// WHAT IT DELIBERATELY DOES NOT DO, and why — this is the stub's documented limit (manager ruling, 2026-10-23):
//
// A Chatwoot webhook is a server-to-server call with NO agent token, and #556 rules out a service-account read
// for this task. So this receiver cannot resolve a conversation's contact to our customer id: any lookup would
// need a principal it does not have, and inventing one would be exactly the thing the ruling forbids. It also
// persists nothing, because a conversation→customer link is a table this service does not own.
//
// So it does three things and stops: it verifies the signature (HMAC-SHA256 over the raw body — see
// `signBody`; Chatwoot's own header format is NOT confirmed and is a launch-checklist item), it HASHES the
// contact's e-mail on arrival so the raw address is never handled downstream, and it returns the link as
// (conversation id → `email_hash`).
// The resolution to a customer id happens on the DASHBOARD request, which does carry the agent's token — the
// `/support/customers/:id/context` route. A link table and a principal are a later phase, not this one.
//
// REPLAY SAFETY. The signature alone is replayable: an intercepted body with its valid signature can be sent
// again for ever. Two guards, both deliberate and both limited:
//
//   * FRESHNESS: the payload's own `created_at` must be within `maxAgeMs`. Clock-based, so it depends on
//     Chatwoot's clock and ours being roughly aligned; the window is wide (5 minutes by default) for exactly
//     that reason. A payload with no usable timestamp is REJECTED rather than waved through.
//   * SEEN-ONCE: an in-memory LRU of recently seen (conversation, event, timestamp) digests. This is a single
//     process's memory, so a restart forgets it and a second instance would not share it — the same honest
//     limitation as the ops rate limiter. It is enough for this stub precisely because the stub has no side
//     effect to replay: nothing is written and nothing is sent. The day it does something stateful, the guard
//     has to become a table, and that is a REQUEST.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SupportError } from './types.js';

export interface ChatwootLink {
  /** The Chatwoot conversation this event is about. */
  conversationId: string;
  /** The Chatwoot account, when the payload carries one. */
  accountId: string | null;
  event: string;
  /** sha256 of the lowercased, trimmed contact e-mail — never the address itself. */
  emailHash: string | null;
  /** The payload's own timestamp, as it sent it. */
  occurredAt: string;
}

export interface ChatwootVerifierOptions {
  /** `CHATWOOT_WEBHOOK_SECRET`, environment only. */
  secret: string;
  /** How old a payload may be. Default 5 minutes. */
  maxAgeMs?: number;
  /** How many digests to remember. Default 1000. */
  seenMax?: number;
  /** Test seam. */
  now?: () => number;
}

export interface ChatwootReceiver {
  /**
   * Verifies and parses one delivery. `signature` is the raw header value; `body` is the RAW request body,
   * because an HMAC is over bytes and re-serialising JSON changes them.
   */
  receive(body: string, signature: string | undefined): ChatwootLink;
  /** Diagnostics only. */
  seenCount(): number;
}

/** sha256 of the lowercased, trimmed address — the same shape the events contract uses for `email_hash`. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** Constant-time compare of two hex digests of equal length. */
function sameSignature(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself not secret.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * HMAC-SHA256 over the RAW body, hex. A real keyed MAC: the first version of this computed
 * `sha256(secret + '.' + body)`, which is a keyed hash and not an HMAC — it lacks HMAC's inner/outer padding
 * and is the construction length-extension attacks are written about (#573 review). `createHmac` is the
 * primitive; nothing here should hand-roll one.
 */
export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Senders differ on whether the header is a bare hex digest or prefixed (`sha256=<hex>`, the GitHub style that
 * `x-hub-signature-256` implies). Both are accepted, case-insensitively on the hex.
 *
 * CHATWOOT'S OWN FORMAT IS NOT CONFIRMED. I could not find its documented header name or signing scheme, so
 * this verifies the standard construction and accepts both shapes rather than inventing a specific one. Before
 * live use the exact header, prefix and encoding must be checked against a real delivery or the Chatwoot
 * source — it is a launch-checklist item, next to "a real Chatwoot instance".
 */
function normaliseSignature(header: string): string {
  const trimmed = header.trim();
  const eq = trimmed.indexOf('=');
  const value = eq === -1 ? trimmed : trimmed.slice(eq + 1);
  return value.toLowerCase();
}

export function createChatwootReceiver(opts: ChatwootVerifierOptions): ChatwootReceiver {
  if (!opts.secret?.trim()) throw new Error('chatwoot: CHATWOOT_WEBHOOK_SECRET is required');
  const secret = opts.secret.trim();
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60 * 1000;
  const seenMax = opts.seenMax ?? 1000;
  const now = opts.now ?? (() => Date.now());
  /** Insertion-ordered, so the oldest digest is the first key. */
  const seen = new Set<string>();

  return {
    receive(body, signature) {
      if (!signature) throw new SupportError(401, 'unauthorized', 'Missing signature');
      // 401 for a bad signature, as #556 asks — and the same message whatever was wrong with it.
      if (!sameSignature(normaliseSignature(signature), signBody(secret, body))) {
        throw new SupportError(401, 'unauthorized', 'Bad signature');
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        throw new SupportError(400, 'bad_request', 'Body is not JSON');
      }

      const conversation = payload.conversation as Record<string, unknown> | undefined;
      const conversationId =
        conversation && conversation.id !== undefined
          ? String(conversation.id)
          : payload.conversation_id !== undefined
            ? String(payload.conversation_id)
            : null;
      if (!conversationId) {
        throw new SupportError(400, 'bad_request', 'Payload names no conversation');
      }

      const event = typeof payload.event === 'string' ? payload.event : '';
      if (!event) throw new SupportError(400, 'bad_request', 'Payload names no event');

      const occurredAtRaw =
        (typeof payload.created_at === 'string' && payload.created_at) ||
        (conversation && typeof conversation.created_at === 'string' && conversation.created_at) ||
        null;
      const occurredAtMs = occurredAtRaw ? Date.parse(occurredAtRaw) : Number.NaN;
      if (!Number.isFinite(occurredAtMs)) {
        // Rejected rather than accepted: without a timestamp the freshness guard does not exist, and a stub
        // that waves those through is a stub with no replay protection at all.
        throw new SupportError(400, 'bad_request', 'Payload carries no usable timestamp');
      }
      if (Math.abs(now() - occurredAtMs) > maxAgeMs) {
        throw new SupportError(401, 'unauthorized', 'Payload is outside the freshness window');
      }

      // The digest is over the identity of the delivery, not the body, so a re-send with a cosmetically
      // different body is still caught.
      const digest = createHash('sha256')
        .update(`${conversationId}.${event}.${occurredAtRaw ?? ''}`)
        .digest('hex');
      if (seen.has(digest)) {
        throw new SupportError(409, 'replayed', 'This delivery has already been received');
      }
      seen.add(digest);
      if (seen.size > seenMax) {
        // Insertion order: drop the oldest.
        const oldest = seen.values().next().value as string | undefined;
        if (oldest) seen.delete(oldest);
      }

      // The contact's address is hashed HERE, on arrival, so nothing downstream ever holds it.
      const contact = (payload.contact ??
        (payload.meta as Record<string, unknown> | undefined)?.sender) as
        Record<string, unknown> | undefined;
      const email = contact && typeof contact.email === 'string' ? contact.email : null;

      return {
        conversationId,
        accountId:
          payload.account !== undefined &&
          (payload.account as Record<string, unknown>).id !== undefined
            ? String((payload.account as Record<string, unknown>).id)
            : null,
        event,
        emailHash: email ? hashEmail(email) : null,
        occurredAt: occurredAtRaw as string,
      };
    },

    seenCount() {
      return seen.size;
    },
  };
}
