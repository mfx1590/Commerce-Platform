// The CDP consumer: bus -> identity + consent -> mapper -> adapter.
//
// Group `engagement.cdp`, on the events-v1 SDK, with the shared `consumer_processed` marks — the same shape as
// the ops consumer (#553), including post-then-mark: a CDP call is a network call and cannot join the mark's
// transaction, so a redelivery sends nothing (the SDK checks the marks before the handler) while a crash in the
// gap can repeat one call. The CDP's `messageId` is the envelope's `event_id`, which IS the outbox id by
// contract (ADR 0003 item 2: `event_id` = the outbox row id, and it travels in the `outbox_id` header that the
// SDK dedupes on), so a repeated call is de-duplicable downstream on the same key we dedupe on here. The
// mapper reads it from the envelope because that is all a pure mapper is given; the two are the same value.
//
// The SDK writes the mark after this handler returns; `ctx.markProcessed(tx)` is for handlers whose side
// effects are database writes, and a CDP call is not one (#562 review).
//
// TWO CLIENTS, and the reason is structural (manager ruling 2026-10-23):
//   * the ORGANIZATION client writes the marks — `consumer_processed` is RLS kind `organization_only`, so a
//     store-scoped client can neither read nor write it;
//   * a STORE-SCOPED client, built per event for the event's own store, reads the consent projection and
//     resolves the order's customer. Consent is per (customer, store, purpose) and is never propagated across
//     stores (0194), so scoping that read to the event's store makes a cross-store read impossible rather than
//     merely wrong.
//
// A dropped event is never silent: every drop is one log line with a reason (`consent_revoked`, `no_identity`,
// …) AND the consent mode it was judged under, because "the CDP is empty" is otherwise an unanswerable
// question — and with a per-store mode (#576) "empty for which store, under which rule" is the real question.

import { createTenantClient, type ScopedClient } from '@platform/db';
import { assertConsentModeOverridesKnown } from '../consent-mode.js';
import {
  createConsumer,
  createPgProcessedStore,
  type EventConsumer,
  type EventEnvelopeV1Base,
} from '@platform/events';
import { PROCESSED_TABLE, type Kafka } from '../ops/consumer.js';
import { createStoreCodes, type StoreCodes } from '../ops/store-codes.js';
import {
  CONSENT_PURPOSE,
  gate,
  readCustomerFacts,
  readOrderCustomerFacts,
  type ConsentMode,
  type DropReason,
} from '../consent.js';
import { CDP_CALL_FOR, isConsentGated, isMapped, mapEvent, cdpTopics } from './mapper.js';
import { sendCall, type CdpAdapter, type CdpCall } from './types.js';

export const CDP_GROUP_ID = 'engagement.cdp';

/** The pool type, taken from the public API: `pg` is deliberately not a dependency of this app. */
export type AppPool = Parameters<typeof createTenantClient>[0];

/** Which topics resolve their identity from the order row rather than the payload (see the tracking plan). */
const FROM_ORDER_ROW = new Set([
  'order.cancelled',
  'payment.captured',
  'refund.issued',
  'shipment.shipped',
  'return.requested',
]);

export interface CdpLogLine {
  service: 'engagement';
  module: 'cdp';
  event: 'sent' | 'dropped' | 'skipped_unmapped' | 'started' | 'stopped';
  topic?: string;
  outbox_id?: string;
  call?: CdpCall['kind'];
  cdp_event?: string;
  store_code?: string;
  /** Why nothing was sent. Never any customer data — a reason code only. */
  reason?: DropReason;
  /** The consent mode this event was judged under (#576). On every per-event line, so a send or a drop is
   *  explainable without a debugger — and so a per-store override is visible in the log rather than guessed. */
  consent_mode?: ConsentMode;
  adapter?: string;
  group_id?: string;
}

export interface CdpHandlerDeps {
  /** Organization-scoped client (the marks) — also used to resolve store codes. */
  hq: ScopedClient;
  /**
   * The effective consent mode for a store code (#576). Resolved PER EVENT rather than once at startup,
   * because it is per store and one process serves every store of the organization. Defaults to `strict` when
   * absent: a caller that forgets to pass it gets the cautious behaviour.
   */
  consentModeFor?: (storeCode: string) => ConsentMode;
  /** Builds the store-scoped client for one store; injectable so a test can pass a fixed one. */
  storeClientFor: (storeId: string) => ScopedClient;
  storeCodes: StoreCodes;
  adapter: CdpAdapter;
  purpose?: string;
  log?: (line: CdpLogLine) => void;
}

/**
 * One event, all the way to the adapter. Exported so a test (and a later replay) can drive the whole decision
 * path without a broker. Returns what happened, so a caller can count.
 */
export async function handleCdpEvent(
  envelope: EventEnvelopeV1Base,
  outboxId: string,
  deps: CdpHandlerDeps,
): Promise<{ sent: CdpCall | null; reason?: DropReason }> {
  const topic = envelope.topic;
  if (!isMapped(topic)) {
    deps.log?.({
      service: 'engagement',
      module: 'cdp',
      event: 'skipped_unmapped',
      topic,
      outbox_id: outboxId,
    });
    return { sent: null };
  }

  const gated = isConsentGated(topic);
  const purpose = deps.purpose ?? CONSENT_PURPOSE;
  const payload = envelope.payload as Record<string, unknown>;
  const emailHash = typeof payload.email_hash === 'string' ? payload.email_hash : null;

  // An organization-scope event has no store, so there is no per-store consent to read: nothing to send.
  if (!envelope.store_id) {
    deps.log?.({
      service: 'engagement',
      module: 'cdp',
      event: 'dropped',
      topic,
      outbox_id: outboxId,
      reason: 'no_identity',
    });
    return { sent: null, reason: 'no_identity' };
  }

  // The store code is resolved FIRST now, because the consent mode is per store (#576) and the gate needs it.
  const storeCode = await deps.storeCodes.codeFor(envelope.store_id);
  const mode: ConsentMode = deps.consentModeFor?.(storeCode) ?? 'strict';

  const store = deps.storeClientFor(envelope.store_id);
  let decision;
  if (FROM_ORDER_ROW.has(topic)) {
    const orderId = payload.order_id as string;
    const facts = await readOrderCustomerFacts(store, orderId, purpose);
    decision = gate({ gated, facts, emailHash, orderFound: facts.orderFound, mode });
  } else {
    const customerId = payload.customer_id as string | null;
    if (!customerId) {
      decision = gate({
        gated,
        facts: {
          found: false,
          customerId: null,
          status: null,
          consent: { granted: null, at: null },
        },
        emailHash,
        mode,
      });
    } else {
      const facts = await readCustomerFacts(store, customerId, purpose);
      // The core KEEPS the customer row and sets `status = 'erased'` (#586 review corrected this comment,
      // which used to say the row is deleted); the consent projection row may be gone, though. Either
      // way the payload's id is the identity to suppress, and `status = 'erased'` is refused in both modes.
      decision = gate({
        gated,
        facts: facts.found ? facts : { ...facts, customerId: gated ? null : customerId },
        emailHash,
        mode,
      });
    }
  }

  if (!decision.send) {
    deps.log?.({
      service: 'engagement',
      module: 'cdp',
      event: 'dropped',
      topic,
      outbox_id: outboxId,
      ...(CDP_CALL_FOR[topic] ? { call: CDP_CALL_FOR[topic] } : {}),
      store_code: storeCode,
      consent_mode: mode,
      reason: decision.reason,
    });
    return { sent: null, reason: decision.reason };
  }

  const call = mapEvent(envelope, { identity: decision.identity, storeCode });
  if (!call) return { sent: null };

  await sendCall(deps.adapter, call);
  deps.log?.({
    service: 'engagement',
    module: 'cdp',
    event: 'sent',
    topic,
    outbox_id: outboxId,
    call: call.kind,
    ...(call.kind === 'track' ? { cdp_event: call.event } : {}),
    store_code: storeCode,
    consent_mode: mode,
    adapter: deps.adapter.name,
  });
  return { sent: call };
}

export interface CdpConsumerOptions {
  hq: ScopedClient;
  /** The pool the per-store clients are built on (the same `platform_app` pool as `hq`). */
  pool: AppPool;
  adapter: CdpAdapter;
  kafka?: Kafka;
  topicPrefix?: string;
  retries?: number;
  fromBeginning?: boolean;
  purpose?: string;
  /** Per-store consent mode (#576); `config.cdp.consentModeFor`. Defaults to `strict` when absent. */
  consentModeFor?: (storeCode: string) => ConsentMode;
  /**
   * The per-store overrides behind `consentModeFor`, keyed by the normalised store key
   * (`config.cdp.consentModeOverrides`). Given, `start()` fails on a key that names no store of this
   * organization (#586). Omitted, nothing is checked — a test that hands in a resolver directly does not
   * have to describe where it came from.
   */
  consentModeOverrides?: ReadonlyMap<string, ConsentMode>;
  log?: (line: CdpLogLine) => void;
  /** Test seam: supply the store-scoped client instead of building one from the pool. */
  storeClientFor?: (storeId: string) => ScopedClient;
  /**
   * The store-code cache to use. The entry point passes the one it warmed for its own startup checks, so the
   * organization's stores are read once per process rather than once per consumer (#590 review).
   */
  storeCodes?: StoreCodes;
}

export interface CdpConsumer {
  readonly groupId: string;
  readonly dlqTopic: string;
  readonly sent: number;
  readonly dropped: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCdpConsumer(opts: CdpConsumerOptions): CdpConsumer {
  const organizationId = opts.hq.context.organizationId;
  const storeCodes = opts.storeCodes ?? createStoreCodes(opts.hq);
  const processed = createPgProcessedStore(opts.hq, PROCESSED_TABLE);
  const storeClientFor =
    opts.storeClientFor ??
    ((storeId: string) => createTenantClient(opts.pool, { organizationId, storeIds: [storeId] }));
  let sent = 0;
  let dropped = 0;

  const consumer: EventConsumer = createConsumer({
    groupId: CDP_GROUP_ID,
    topics: cdpTopics(),
    processed,
    ...(opts.kafka ? { kafka: opts.kafka } : {}),
    ...(opts.topicPrefix === undefined ? {} : { topicPrefix: opts.topicPrefix }),
    ...(opts.retries === undefined ? {} : { retries: opts.retries }),
    ...(opts.fromBeginning === undefined ? {} : { fromBeginning: opts.fromBeginning }),
    handler: async ({ envelope, outboxId }) => {
      const r = await handleCdpEvent(envelope, outboxId, {
        hq: opts.hq,
        storeClientFor,
        storeCodes,
        adapter: opts.adapter,
        ...(opts.purpose === undefined ? {} : { purpose: opts.purpose }),
        ...(opts.consentModeFor ? { consentModeFor: opts.consentModeFor } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      });
      if (r.sent) sent += 1;
      else dropped += 1;
      // No mark here: the SDK writes it after this handler returns. See the file header.
    },
  });

  return {
    groupId: CDP_GROUP_ID,
    dlqTopic: consumer.dlqTopic,
    get sent() {
      return sent;
    },
    get dropped() {
      return dropped;
    },
    async start() {
      await storeCodes.warm();
      // #586: an override naming no store fails the boot HERE, because this is the first moment the store
      // list exists — `resolveConfig` has no database. It therefore only runs when the CDP is enabled, which
      // is the accepted limit: a consumer that is not running applies no mode to anything, so there is
      // nothing for a stray key to silently fail to do.
      if (opts.consentModeOverrides) {
        assertConsentModeOverridesKnown(opts.consentModeOverrides, storeCodes.codes());
      }
      await consumer.start();
      opts.log?.({
        service: 'engagement',
        module: 'cdp',
        event: 'started',
        group_id: CDP_GROUP_ID,
        adapter: opts.adapter.name,
      });
    },
    async stop() {
      await consumer.stop();
      opts.log?.({
        service: 'engagement',
        module: 'cdp',
        event: 'stopped',
        group_id: CDP_GROUP_ID,
      });
    },
  };
}
