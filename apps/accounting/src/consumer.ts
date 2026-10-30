// The ledger consumer (#548): group `accounting.ledger` on the events-v1 consumer SDK, five topics, one transaction
// per event: advisory lock on the order → load the order projection → pure posting → ledger rows + projection
// writes → ctx.markProcessed(tx).
// The processed row commits WITH the ledger rows (exactly once per group); UNIQUE (source_event_id, account_code)
// on ledger_entry is the second guard.
//
// Out-of-order arrival is normal (the five topics are separate partitions; a replay into a fresh group reads them
// all at once): a shipment / refund / cancel whose order.placed has not arrived is PARKED with its mark, and the
// order's handler applies the parked events in occurred_at order inside its own transaction (manager decision
// 2026-10-23). The DLQ is for real failures only.
import type { ScopedClient, Queryable } from '@platform/db';
import {
  createConsumer,
  createPgProcessedStore,
  createValidator,
  type ConsumerLogLine,
  type DecodedMessage,
  type EventConsumer,
  type EventEnvelopeV1Base,
  createKafka,
} from '@platform/events';
import { ForeignOrganizationError, InvalidEventError, PostingError } from './errors.js';
import { ensureChart, insertJournalEntry } from './ledger.js';
import { consoleLogger, errorClassOf, type Logger } from './log.js';
import {
  isLedgerTopic,
  legalEntityIdOf,
  LEDGER_TOPICS,
  needsOrderProjection,
  orderIdOf,
  postEvent,
  type OrderProjection,
  type PostingResult,
} from './posting/index.js';
import {
  deleteParkedEvents,
  loadOrderProjection,
  loadParkedEvents,
  parkEvent,
  saveOrderProjection,
  savePaymentProjection,
  saveRefundProjection,
} from './projection.js';

export const LEDGER_GROUP = 'accounting.ledger';
export const PROCESSED_TABLE = 'consumer_processed';
/** Handler attempts before the DLQ (the SDK default): a failure here is a defect, not lag. */
export const LEDGER_RETRIES = 5;

type Kafka = ReturnType<typeof createKafka>;
type Validator = ReturnType<typeof createValidator>;

export interface HandledEvent {
  /** posted = rows written; parked = waiting for its order; noop = nothing to write; ignored = not a ledger topic. */
  action: 'posted' | 'parked' | 'noop' | 'ignored';
  outbox_id: string;
  topic: string;
  legal_entity_id: string | null;
  /** Journal entries written by this event (and by the parked events it applied). */
  entries: number;
  lines: number;
  /** Parked events an order.placed applied in this transaction. */
  applied_parked: number;
  /**
   * Parked events the order.placed could NOT apply because posting them is a defect (e.g. a shipment dated after the
   * cancellation): they stay in accounting_parked_event, the order and the rest post (#639). Empty otherwise.
   */
  parked_defects: { outbox_id: string; topic: string; error_class: string }[];
}

export interface HandleOptions {
  /** `ctx.markProcessed` of the SDK: called with the transaction so the mark commits with the rows. */
  markProcessed?: (tx: Queryable) => Promise<void>;
  validator?: Validator;
}

let sharedValidator: Validator | undefined;
const validator = (): Validator => (sharedValidator ??= createValidator());

/**
 * Posts one decoded message on `client` (organization scope). Throws to make the SDK retry; the error's `name` is
 * what the dead letter records. Exported for the tests and the DLQ replay.
 */
export async function handleLedgerEvent(
  client: ScopedClient,
  message: DecodedMessage,
  opts: HandleOptions = {},
): Promise<HandledEvent> {
  const { envelope, outboxId } = message;
  const base = {
    outbox_id: outboxId,
    topic: envelope.topic,
    entries: 0,
    lines: 0,
    applied_parked: 0,
    parked_defects: [] as HandledEvent['parked_defects'],
  };
  if (!isLedgerTopic(envelope.topic)) return { ...base, action: 'ignored', legal_entity_id: null };
  const check = (opts.validator ?? validator()).validateEnvelope(envelope as EventEnvelopeV1Base);
  if (!check.ok) throw new InvalidEventError(envelope.event_id, check.errors);
  if (envelope.organization_id !== client.context.organizationId)
    throw new ForeignOrganizationError(envelope.event_id);
  const legalEntityId = legalEntityIdOf(envelope);
  const orderId = orderIdOf(envelope);

  return client.transaction(async (tx) => {
    // FOR UPDATE on a MISSING projection row locks nothing: with two instances of the group a shipment could be parked
    // at the same moment its order.placed applies the parked events, and stay parked. One transaction-scoped advisory
    // lock per order serialises every event of that order across instances (Fable review of #567, follow-up a).
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orderId]);
    const order = await loadOrderProjection(tx, orderId);
    if (!order && needsOrderProjection(envelope)) {
      await parkEvent(tx, envelope, outboxId, orderId);
      if (opts.markProcessed) await opts.markProcessed(tx);
      return { ...base, action: 'parked', legal_entity_id: legalEntityId };
    }

    let entries = 0;
    let lines = 0;
    let chartEnsured = false;
    const write = async (r: PostingResult): Promise<void> => {
      if (r.entries.length > 0 && !chartEnsured) {
        await ensureChart(tx, envelope.organization_id, legalEntityId);
        chartEnsured = true;
      }
      for (const entry of r.entries) {
        lines += await insertJournalEntry(tx, envelope.organization_id, entry);
        entries += 1;
      }
      if (r.payment) await savePaymentProjection(tx, r.payment);
      if (r.refund) await saveRefundProjection(tx, r.refund);
    };

    const result = postEvent(envelope, order);
    await write(result);
    let projection: OrderProjection | null = result.order ?? order;
    let applied = 0;
    const defects: HandledEvent['parked_defects'] = [];
    if (envelope.topic === 'order.placed' && result.order) {
      // the order is here: apply what arrived before it, in the order the facts happened
      const appliedIds: string[] = [];
      for (const parked of await loadParkedEvents(tx, orderId)) {
        let r: PostingResult;
        try {
          r = postEvent(parked.envelope, projection); // pure: a throw here has written nothing
        } catch (err) {
          // #639: a parked event that is a DEFECT (a shipment dated after the cancellation, an over-shipment…) fails on
          // its own: it stays parked (never deleted, visible through listParkedEvents) and the order still posts.
          // Before, the throw dead-lettered the order.placed itself and the whole order stayed unposted.
          if (!(err instanceof PostingError)) throw err;
          defects.push({
            outbox_id: parked.outbox_id,
            topic: parked.envelope.topic,
            error_class: err.name,
          });
          continue;
        }
        await write(r);
        if (r.order) projection = r.order;
        appliedIds.push(parked.outbox_id);
        applied += 1;
      }
      if (applied > 0) await deleteParkedEvents(tx, orderId, appliedIds);
    }
    if (projection && (result.order || applied > 0)) await saveOrderProjection(tx, projection);
    if (opts.markProcessed) await opts.markProcessed(tx);
    return {
      ...base,
      action: entries > 0 ? 'posted' : 'noop',
      legal_entity_id: legalEntityId,
      entries,
      lines,
      applied_parked: applied,
      parked_defects: defects,
    };
  });
}

export interface LedgerConsumerDeps {
  /** Organization-scoped client over the app-role pool. */
  client: ScopedClient;
  kafka?: Kafka;
  /** Tests: prefix for the topics and the DLQ. */
  topicPrefix?: string;
  /** Tests: a throwaway group next to the real `accounting.ledger` on a shared broker. */
  groupId?: string;
  log?: Logger;
  retries?: number;
  fromBeginning?: boolean;
  /** Test seam: no real waits between attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** Diagnostics: every batch the SDK hands us (the `--once` idle detector uses it). */
  onBatch?: (batch: { topic: string; partition: number; size: number }) => void;
}

/** The consumer; `start()` ensures `dlq.accounting.ledger`, subscribes and runs; `stop()` leaves the group. */
export function createLedgerConsumer(deps: LedgerConsumerDeps): EventConsumer {
  const log = deps.log ?? consoleLogger;
  const groupId = deps.groupId ?? LEDGER_GROUP;
  const kafka = deps.kafka ?? createKafka({ clientId: `consumer-${groupId}` });
  const sdkLog = (line: ConsumerLogLine): void => {
    const { consumer: _c, event, ...rest } = line;
    log.info({ event: `sdk.${event}`, ...rest });
  };
  return createConsumer({
    groupId,
    topics: [...LEDGER_TOPICS],
    kafka,
    processed: createPgProcessedStore(deps.client, PROCESSED_TABLE),
    retries: deps.retries ?? LEDGER_RETRIES,
    log: sdkLog,
    ...(deps.topicPrefix !== undefined ? { topicPrefix: deps.topicPrefix } : {}),
    ...(deps.fromBeginning !== undefined ? { fromBeginning: deps.fromBeginning } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.onBatch ? { onBatch: deps.onBatch } : {}),
    handler: async (message, ctx) => {
      try {
        const r = await handleLedgerEvent(deps.client, message, {
          markProcessed: (tx) => ctx.markProcessed(tx),
        });
        log.info({ event: r.action, ...r, attempt: ctx.attempt });
        for (const d of r.parked_defects)
          // error level: a stuck parked event is a defect someone must act on, never only visible on request (#639)
          log.error({ event: 'parked_event_defect', order_outbox_id: r.outbox_id, ...d });
      } catch (err) {
        log.warn({
          event: 'posting_failed',
          outbox_id: message.outboxId,
          topic: message.envelope.topic,
          attempt: ctx.attempt,
          error_class: errorClassOf(err),
        });
        throw err;
      }
    },
  });
}
