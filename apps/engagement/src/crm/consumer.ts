// The CRM consumer (#555): bus -> consent -> PII + rollup -> CRM.
//
// Group `engagement.crm`, same SDK, same shared marks, same two clients and the same post-then-mark trade as
// #553/#554 (the SDK writes the mark after the handler; an HTTP upsert cannot join a transaction). What is
// different here is worth stating plainly:
//
//   * THIS IS THE ONLY MODULE THAT HANDLES PII. The name and the e-mail are fetched from the core Admin API
//     with this service's own principal (#565) and exist in a `CrmContact` on the way to the adapter. They are
//     never logged, never stored by us, never in an error and never in a dead letter.
//   * IDEMPOTENCY COMES FROM RECOMPUTING, not from the marks. Every event recomputes the rollup from the
//     customer's own rows (`rollup.ts` explains why) and upserts by our customer id, so handling the same
//     event twice writes the same contact. The marks save the work; they are not what makes it correct.
//   * CONSENT GATES THE WHOLE CONTACT. A CRM contact is marketing-shaped, so without granted consent nothing
//     is synced at all — not a name, not a number (manager decision on #555, and the same gate as #554).
//     `customer.erased` is the exception: it deletes, whatever consent says.

import { createTenantClient, type ScopedClient } from '@platform/db';
import {
  createConsumer,
  createPgProcessedStore,
  type EventConsumer,
  type EventEnvelopeV1Base,
  type EventTopic,
} from '@platform/events';
import { gate, readCustomerFacts, type DropReason } from '../cdp/consent.js';
import { PROCESSED_TABLE, type Kafka } from '../ops/consumer.js';
import type { AppPool } from '../cdp/consumer.js';
import { computeRollup } from './rollup.js';
import { readOrderHistory, readStoreFacts } from './read.js';
import type { CustomerReader } from './admin-api.js';
import type { CrmAdapter, CrmContact } from './types.js';

export const CRM_GROUP_ID = 'engagement.crm';

/** The topics that drive the sync (#555). `customer.erased` deletes; the rest upsert. */
export const CRM_TOPICS: EventTopic[] = [
  'customer.created',
  'customer.updated',
  'customer.erased',
  'order.placed',
  'order.cancelled',
  'refund.issued',
];

/** Topics whose payload names the customer directly; the rest name an order. */
const CUSTOMER_TOPICS = new Set<string>([
  'customer.created',
  'customer.updated',
  'customer.erased',
]);

/** Why nothing was synced. The consent reasons are #554's, plus the three this module adds. */
export type CrmSkipReason = DropReason | 'unmapped' | 'store_unknown' | 'customer_gone';

export type CrmOutcome =
  | { action: 'upserted'; contact: CrmContact }
  | { action: 'removed'; externalId: string }
  | { action: 'skipped'; reason: CrmSkipReason };

export interface CrmLogLine {
  service: 'engagement';
  module: 'crm';
  event: 'upserted' | 'removed' | 'skipped' | 'started' | 'stopped';
  topic?: string;
  outbox_id?: string;
  /** Our customer id — an id, not PII. Never a name or an e-mail. */
  customer_id?: string;
  store_code?: string;
  orders_count?: number;
  /** Whether the headline figures are partial because the customer has other-currency orders. */
  mixed_currency?: boolean;
  reason?: CrmSkipReason;
  adapter?: string;
  group_id?: string;
}

export interface CrmHandlerDeps {
  hq: ScopedClient;
  storeClientFor: (storeId: string) => ScopedClient;
  customers: CustomerReader;
  adapter: CrmAdapter;
  log?: (line: CrmLogLine) => void;
}

/** Resolves the customer id an event is about: from the payload, or from the order it names. */
async function customerIdOf(
  envelope: EventEnvelopeV1Base,
  store: ScopedClient,
): Promise<string | null> {
  const payload = envelope.payload as Record<string, unknown>;
  if (CUSTOMER_TOPICS.has(envelope.topic)) {
    return typeof payload.customer_id === 'string' ? payload.customer_id : null;
  }
  const orderId = payload.order_id;
  if (typeof orderId !== 'string') return null;
  const r = await store.query('SELECT customer_id FROM "order" WHERE id = $1', [orderId]);
  return (r.rows[0] as { customer_id: string | null } | undefined)?.customer_id ?? null;
}

/**
 * One event, all the way to the CRM. Exported so a test (and a later replay) drives the whole decision path
 * without a broker.
 */
export async function handleCrmEvent(
  envelope: EventEnvelopeV1Base,
  outboxId: string,
  deps: CrmHandlerDeps,
): Promise<CrmOutcome> {
  const log = (line: Omit<CrmLogLine, 'service' | 'module'>) =>
    deps.log?.({ service: 'engagement', module: 'crm', ...line } as CrmLogLine);

  if (!CRM_TOPICS.includes(envelope.topic)) {
    log({ event: 'skipped', topic: envelope.topic, outbox_id: outboxId, reason: 'unmapped' });
    return { action: 'skipped', reason: 'unmapped' };
  }
  if (!envelope.store_id) {
    log({ event: 'skipped', topic: envelope.topic, outbox_id: outboxId, reason: 'no_identity' });
    return { action: 'skipped', reason: 'no_identity' };
  }

  const store = deps.storeClientFor(envelope.store_id);
  const customerId = await customerIdOf(envelope, store);
  if (!customerId) {
    // A guest order has no customer: there is nobody to be a contact.
    log({ event: 'skipped', topic: envelope.topic, outbox_id: outboxId, reason: 'no_identity' });
    return { action: 'skipped', reason: 'no_identity' };
  }

  // --- the erasure path: delete, whatever consent says, and before anything is read ---
  if (envelope.topic === 'customer.erased') {
    await deps.adapter.remove(customerId);
    log({
      event: 'removed',
      topic: envelope.topic,
      outbox_id: outboxId,
      customer_id: customerId,
      adapter: deps.adapter.name,
    });
    return { action: 'removed', externalId: customerId };
  }

  // --- consent, before any PII is fetched: no consent, no Admin API call at all ---
  const facts = await readCustomerFacts(store, customerId);
  const decision = gate({ gated: true, facts });
  if (!decision.send) {
    log({
      event: 'skipped',
      topic: envelope.topic,
      outbox_id: outboxId,
      customer_id: customerId,
      reason: decision.reason,
    });
    return { action: 'skipped', reason: decision.reason };
  }

  const storeFacts = await readStoreFacts(store, envelope.store_id);
  if (!storeFacts) {
    log({ event: 'skipped', topic: envelope.topic, outbox_id: outboxId, reason: 'store_unknown' });
    return { action: 'skipped', reason: 'store_unknown' };
  }

  // The PII, with this service's own principal and permission.
  const pii = await deps.customers.getCustomer(envelope.store_id, customerId);
  if (!pii || pii.status === 'erased') {
    log({
      event: 'skipped',
      topic: envelope.topic,
      outbox_id: outboxId,
      customer_id: customerId,
      reason: 'customer_gone',
    });
    return { action: 'skipped', reason: 'customer_gone' };
  }

  const history = await readOrderHistory(store, customerId);
  const rollup = computeRollup(history.orders, history.refunds, {
    defaultCurrency: storeFacts.defaultCurrency,
  });

  const contact: CrmContact = {
    externalId: customerId,
    storeCode: storeFacts.code,
    email: pii.email,
    firstName: pii.first_name,
    lastName: pii.last_name,
    ordersCount: rollup.orders_count,
    netRevenueMinor: rollup.net_revenue_minor,
    currency: rollup.currency,
    lastOrderAt: rollup.last_order_at,
  };
  await deps.adapter.upsert(contact);
  log({
    event: 'upserted',
    topic: envelope.topic,
    outbox_id: outboxId,
    customer_id: customerId,
    store_code: storeFacts.code,
    orders_count: rollup.orders_count,
    mixed_currency: rollup.mixed_currency,
    adapter: deps.adapter.name,
  });
  return { action: 'upserted', contact };
}

export interface CrmConsumerOptions {
  hq: ScopedClient;
  pool: AppPool;
  customers: CustomerReader;
  adapter: CrmAdapter;
  kafka?: Kafka;
  topicPrefix?: string;
  retries?: number;
  fromBeginning?: boolean;
  log?: (line: CrmLogLine) => void;
  storeClientFor?: (storeId: string) => ScopedClient;
}

export interface CrmConsumer {
  readonly groupId: string;
  readonly dlqTopic: string;
  readonly upserted: number;
  readonly removed: number;
  readonly skipped: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCrmConsumer(opts: CrmConsumerOptions): CrmConsumer {
  const organizationId = opts.hq.context.organizationId;
  const processed = createPgProcessedStore(opts.hq, PROCESSED_TABLE);
  const storeClientFor =
    opts.storeClientFor ??
    ((storeId: string) => createTenantClient(opts.pool, { organizationId, storeIds: [storeId] }));
  let upserted = 0;
  let removed = 0;
  let skipped = 0;

  const consumer: EventConsumer = createConsumer({
    groupId: CRM_GROUP_ID,
    topics: CRM_TOPICS,
    processed,
    ...(opts.kafka ? { kafka: opts.kafka } : {}),
    ...(opts.topicPrefix === undefined ? {} : { topicPrefix: opts.topicPrefix }),
    ...(opts.retries === undefined ? {} : { retries: opts.retries }),
    ...(opts.fromBeginning === undefined ? {} : { fromBeginning: opts.fromBeginning }),
    handler: async ({ envelope, outboxId }) => {
      const r = await handleCrmEvent(envelope, outboxId, {
        hq: opts.hq,
        storeClientFor,
        customers: opts.customers,
        adapter: opts.adapter,
        ...(opts.log ? { log: opts.log } : {}),
      });
      if (r.action === 'upserted') upserted += 1;
      else if (r.action === 'removed') removed += 1;
      else skipped += 1;
      // No mark here: the SDK writes it after this handler returns (#562 review).
    },
  });

  return {
    groupId: CRM_GROUP_ID,
    dlqTopic: consumer.dlqTopic,
    get upserted() {
      return upserted;
    },
    get removed() {
      return removed;
    },
    get skipped() {
      return skipped;
    },
    async start() {
      await consumer.start();
      opts.log?.({
        service: 'engagement',
        module: 'crm',
        event: 'started',
        group_id: CRM_GROUP_ID,
        adapter: opts.adapter.name,
      });
    },
    async stop() {
      await consumer.stop();
      opts.log?.({
        service: 'engagement',
        module: 'crm',
        event: 'stopped',
        group_id: CRM_GROUP_ID,
      });
    },
  };
}
