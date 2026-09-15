// Stripe webhook receiver (task 2.2, #125): signature over the raw body with the store's secret → redacted
// extract → `webhook_event` insert-or-skip (exactly once per `(provider, provider_event_id)`, #187) →
// processing in the SAME transaction as the insert (payment row + payment events through the outbox) → order
// transitions through the orders module's idempotent wrappers → final status. Out-of-order deliveries converge
// through state guards on the payment row, never through `occurred_at`. Nothing here logs a payload.
//
// Table: `webhook_event` from CONTRACT CHANGE #187 (migration 0140, lands after this task and shipping 2.3
// merge). Until then `proposed/0140_webhook_event.sql` is applied by this module's tests only.
import type { Queryable, ScopedClient } from '@platform/db';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { SYSTEM_ACTOR, type Actor } from '../../lib/audit';
import { AppError, conflict, validationError } from '../../lib/errors';
import { cancelOrder } from '../orders';
import { markPaymentCaptured, markPaymentFailed } from './orders-seam';
import { envSuffix, stripeWebhookSecretFor } from './credentials';
import {
  MalformedEventError,
  redactStripeEvent,
  sealExtract,
  sha256Hex,
  verifySeal,
  type WebhookExtract,
} from './webhook-extract';
import { verifyStripeSignature } from './webhook-signature';

export const WEBHOOK_PROVIDER = 'stripe';
/** A `received` row older than this is treated as abandoned: a redelivery takes it over instead of a 409. */
export const IN_FLIGHT_TAKEOVER_SECONDS = 60;

export type WebhookEventStatus = 'received' | 'processed' | 'skipped' | 'failed';

export interface WebhookEventRow {
  id: string;
  organization_id: string;
  store_id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  provider_object_id: string | null;
  aggregate_type: 'payment' | 'refund' | 'shipment' | null;
  aggregate_id: string | null;
  occurred_at: Date | null;
  received_at: Date;
  status: WebhookEventStatus;
  processed_at: Date | null;
  failure_reason: string | null;
  payload: WebhookExtract;
  payload_hash: string;
  replay_count: number;
}

export type WebhookOutcome =
  | {
      kind: 'processed' | 'skipped' | 'failed';
      eventId: string;
      type: string;
      reason: string | null;
      replayed: boolean;
    }
  | { kind: 'duplicate'; eventId: string; type: string; status: WebhookEventStatus };

export interface StripeWebhookInput {
  /** Tenant client scoped to the store the endpoint belongs to. */
  client: ScopedClient;
  storeCode: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Injectable clock (seconds) for the signature tolerance. */
  nowSeconds?: number;
  actor?: Actor;
  /** One line per delivery, ids only. Default `console.info`. */
  log?: (line: string) => void;
}

interface StoreRow {
  id: string;
  organization_id: string;
  legal_entity_id: string;
}

interface PaymentRow {
  id: string;
  organization_id: string;
  store_id: string;
  order_id: string;
  provider_payment_id: string | null;
  amount_minor: string;
  currency: string;
  status: 'pending' | 'authorized' | 'captured' | 'failed' | 'cancelled';
}

type FollowUp = (client: ScopedClient) => Promise<void>;

interface ProcessResult {
  status: Exclude<WebhookEventStatus, 'received'>;
  reason: string | null;
  aggregate: { type: 'payment' | 'refund'; id: string } | null;
  /** Order transitions to run after the commit (each opens its own transaction; idempotent on target state). */
  followUps: FollowUp[];
}

const SELECT_ROW = `SELECT id, organization_id, store_id, provider, provider_event_id, event_type,
  provider_object_id, aggregate_type, aggregate_id, occurred_at, received_at, status, processed_at,
  failure_reason, payload, payload_hash, replay_count FROM webhook_event`;

async function lockPayment(tx: Queryable, intentId: string): Promise<PaymentRow | null> {
  const r = await tx.query<PaymentRow>(
    `SELECT id, organization_id, store_id, order_id, provider_payment_id, amount_minor::text, currency, status
     FROM payment WHERE provider = 'stripe' AND provider_payment_id = $1 FOR UPDATE`,
    [intentId],
  );
  return r.rows[0] ?? null;
}

const skipped = (reason: string, aggregate: ProcessResult['aggregate'] = null): ProcessResult => ({
  status: 'skipped',
  reason,
  aggregate,
  followUps: [],
});
const failed = (reason: string, aggregate: ProcessResult['aggregate'] = null): ProcessResult => ({
  status: 'failed',
  reason,
  aggregate,
  followUps: [],
});

/**
 * Applies one event to our state. Idempotent: every branch checks the payment row's CURRENT status first, so a
 * duplicate, a replay, or an event that arrives after a later one is a `skipped`; an event whose claim
 * contradicts a terminal state of ours (Stripe says captured, our row says cancelled) is a `failed` with a
 * reason — a money discrepancy a human must look at — and nothing moves.
 */
async function processEvent(
  tx: Queryable,
  store: StoreRow,
  extract: WebhookExtract,
  actor: Actor,
): Promise<ProcessResult> {
  const obj = extract.object;
  const intentId = obj.object === 'payment_intent' ? obj.id : obj.payment_intent;

  switch (extract.type) {
    case 'payment_intent.succeeded': {
      if (!intentId) return failed('event carries no payment intent id');
      const payment = await lockPayment(tx, intentId);
      if (!payment)
        return failed(`no payment row for ${intentId}: captured at Stripe without an order`);
      const aggregate = { type: 'payment' as const, id: payment.id };
      if (payment.status === 'captured') {
        return { ...skipped('already captured', aggregate), followUps: [markCaptured(payment)] };
      }
      if (payment.status !== 'authorized') {
        return failed(
          `state_conflict: stripe says succeeded, payment row is ${payment.status}`,
          aggregate,
        );
      }
      if (obj.amount_received !== null && obj.amount_received !== Number(payment.amount_minor)) {
        return failed(
          `amount_conflict: stripe captured ${obj.amount_received}, payment row is ${payment.amount_minor}`,
          aggregate,
        );
      }
      const now = new Date();
      await tx.query(
        `UPDATE payment SET status = 'captured', captured_at = $2, updated_at = now() WHERE id = $1`,
        [payment.id, now],
      );
      await withEvents(tx, [
        await buildEvent({
          topic: 'payment.captured',
          organizationId: payment.organization_id,
          storeId: payment.store_id,
          aggregateType: 'payment',
          aggregateId: payment.id,
          actor: eventActor(actor),
          occurredAt: now,
          payload: {
            payment_id: payment.id,
            order_id: payment.order_id,
            legal_entity_id: store.legal_entity_id,
            provider: 'stripe',
            provider_payment_id: payment.provider_payment_id,
            amount_minor: Number(payment.amount_minor),
            fee_minor: null, // the event object carries no balance transaction; capturePayment fills it
            currency: payment.currency,
            captured_at: now.toISOString(),
          },
        }),
      ]);
      return { status: 'processed', reason: null, aggregate, followUps: [markCaptured(payment)] };
    }

    case 'payment_intent.canceled': {
      if (!intentId) return failed('event carries no payment intent id');
      const payment = await lockPayment(tx, intentId);
      if (!payment) return skipped(`no payment row for ${intentId} (nothing to cancel)`);
      const aggregate = { type: 'payment' as const, id: payment.id };
      if (payment.status === 'cancelled') return skipped('already cancelled', aggregate);
      if (payment.status === 'captured') {
        return failed('state_conflict: stripe says canceled, payment row is captured', aggregate);
      }
      // The orders module owns the cancel: it voids through the provider (already cancelled at Stripe →
      // no-op), marks the payment row cancelled and emits order.cancelled — in its own transaction.
      const reason = obj.cancellation_reason
        ? `payment_intent.canceled at stripe (${obj.cancellation_reason})`
        : 'payment_intent.canceled at stripe';
      return {
        status: 'processed',
        reason: null,
        aggregate,
        followUps: [
          async (client) => {
            await cancelOrder(client, payment.order_id, { reason, actor });
          },
        ],
      };
    }

    case 'payment_intent.payment_failed': {
      if (!intentId) return failed('event carries no payment intent id');
      const payment = await lockPayment(tx, intentId);
      if (!payment) return skipped(`no payment row for ${intentId} (placement did not complete)`);
      const aggregate = { type: 'payment' as const, id: payment.id };
      if (payment.status === 'failed') return skipped('already failed', aggregate);
      if (payment.status !== 'authorized') {
        return failed(
          `state_conflict: stripe says failed, payment row is ${payment.status}`,
          aggregate,
        );
      }
      const now = new Date();
      const failure =
        obj.last_payment_error?.decline_code ?? obj.last_payment_error?.code ?? 'payment_failed';
      await tx.query(
        `UPDATE payment SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
        [payment.id, failure],
      );
      await withEvents(tx, [
        await buildEvent({
          topic: 'payment.failed',
          organizationId: payment.organization_id,
          storeId: payment.store_id,
          aggregateType: 'payment',
          aggregateId: payment.id,
          actor: eventActor(actor),
          occurredAt: now,
          payload: {
            payment_id: payment.id,
            order_id: payment.order_id,
            provider: 'stripe',
            provider_payment_id: payment.provider_payment_id,
            amount_minor: Number(payment.amount_minor),
            currency: payment.currency,
            failure_reason: failure,
            failed_at: now.toISOString(),
          },
        }),
      ]);
      return {
        status: 'processed',
        reason: null,
        aggregate,
        followUps: [
          async (client) => {
            await markPaymentFailed(client, payment.order_id, actor);
          },
        ],
      };
    }

    case 'payment_intent.amount_capturable_updated': {
      // The authorisation itself: our row is inserted `authorized` at placement, so this is always a no-op.
      if (!intentId) return failed('event carries no payment intent id');
      const payment = await lockPayment(tx, intentId);
      return payment
        ? skipped(`payment row is already ${payment.status}`, { type: 'payment', id: payment.id })
        : skipped(`no payment row for ${intentId} yet`);
    }

    default:
      if (extract.type.startsWith('charge.refund') || extract.type.startsWith('refund.')) {
        return skipped('unhandled_type: refunds arrive with task 2.3 (replay after it lands)');
      }
      return skipped('unhandled_type');
  }
}

function markCaptured(payment: PaymentRow): FollowUp {
  return async (client) => {
    await markPaymentCaptured(client, payment.order_id, SYSTEM_ACTOR);
  };
}

/** Runs the order transitions after the commit; an AppError (409 on a shipped order, …) becomes `failed`. */
async function runFollowUps(client: ScopedClient, followUps: FollowUp[]): Promise<string | null> {
  for (const f of followUps) {
    try {
      await f(client);
    } catch (err) {
      if (err instanceof AppError) return `${err.code}: ${err.message}`;
      throw err;
    }
  }
  return null;
}

async function finalize(
  client: ScopedClient,
  rowId: string,
  status: Exclude<WebhookEventStatus, 'received'>,
  reason: string | null,
): Promise<void> {
  await client.query(
    `UPDATE webhook_event SET status = $2, failure_reason = $3, processed_at = now(), updated_at = now()
     WHERE id = $1`,
    [rowId, status, reason],
  );
}

async function loadStore(tx: Queryable, storeCode: string): Promise<StoreRow> {
  const r = await tx.query<StoreRow>(
    `SELECT id, organization_id, legal_entity_id FROM store WHERE code = $1`,
    [storeCode],
  );
  const store = r.rows[0];
  if (!store) throw new AppError('not_found', `store ${storeCode} not found`);
  return store;
}

/**
 * `POST /webhooks/stripe/:storeCode`. Returns the outcome; throws `AppError` for the contract's 400 (signature,
 * malformed body, missing secret — before anything is written), 404 (unknown store) and 409 (a duplicate of an
 * event that is still being processed). A duplicate of a finished event is `{ kind: 'duplicate' }` → 200.
 */
export async function handleStripeWebhook(input: StripeWebhookInput): Promise<WebhookOutcome> {
  const env = input.env ?? process.env;
  const actor = input.actor ?? SYSTEM_ACTOR;
  const log = input.log ?? ((line: string) => console.info(line));

  // ---- 1. signature over the raw body, before any parsing or database work ----
  const secret = stripeWebhookSecretFor(input.storeCode, env);
  if (!secret) {
    const suffix = envSuffix(input.storeCode);
    throw validationError(
      `no stripe webhook secret for store ${input.storeCode}: set STRIPE_WEBHOOK_SECRET_${suffix} or STRIPE_WEBHOOK_SECRET`,
      { provider: 'stripe' },
    );
  }
  const verdict = verifyStripeSignature({
    rawBody: input.rawBody,
    header: input.signatureHeader,
    secret,
    ...(input.nowSeconds !== undefined ? { nowSeconds: input.nowSeconds } : {}),
  });
  if (!verdict.ok) {
    throw validationError('stripe webhook signature rejected', { reason: verdict.reason });
  }

  // ---- 2. parse + redact; hash the raw body; seal the extract to it ----
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    throw validationError('stripe webhook body is not JSON');
  }
  let extract: WebhookExtract;
  try {
    extract = redactStripeEvent(parsed);
  } catch (err) {
    if (err instanceof MalformedEventError) {
      throw validationError('stripe webhook body is not an event', { reason: err.reason });
    }
    throw err;
  }
  const payloadHash = sha256Hex(input.rawBody);
  const sealed = sealExtract(extract, payloadHash);

  // ---- 3. insert-or-skip + processing, one transaction ----
  const first = await input.client.transaction(
    async (
      tx,
    ): Promise<
      | { kind: 'duplicate'; status: WebhookEventStatus }
      | { kind: 'owned'; rowId: string; result: ProcessResult }
    > => {
      const store = await loadStore(tx, input.storeCode);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO webhook_event (organization_id, store_id, provider, provider_event_id, event_type,
           provider_object_id, occurred_at, status, payload, payload_hash)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), 'received', $8::jsonb, $9)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [
          store.organization_id,
          store.id,
          WEBHOOK_PROVIDER,
          sealed.id,
          sealed.type,
          sealed.object.id,
          sealed.created || null,
          JSON.stringify(sealed),
          payloadHash,
        ],
      );
      let rowId = inserted.rows[0]?.id;
      if (!rowId) {
        // The unique index made us WAIT for a concurrent first delivery to commit or roll back; now decide.
        const existing = await tx.query<{ id: string; status: WebhookEventStatus }>(
          `SELECT id, status FROM webhook_event WHERE provider = $1 AND provider_event_id = $2`,
          [WEBHOOK_PROVIDER, sealed.id],
        );
        const row = existing.rows[0];
        if (!row) throw conflict('webhook event vanished between insert and lookup; retry'); // rolled back peer
        if (row.status !== 'received') return { kind: 'duplicate', status: row.status };
        // Still `received`: in flight (its follow-ups are running) or abandoned by a crash. Take over only
        // when it is old enough to be abandoned; otherwise the sender retries later.
        const takeover = await tx.query<{ id: string }>(
          `UPDATE webhook_event SET received_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'received' AND received_at < now() - make_interval(secs => $2)
           RETURNING id`,
          [row.id, IN_FLIGHT_TAKEOVER_SECONDS],
        );
        if (!takeover.rows[0]) {
          throw conflict(`webhook event ${sealed.id} is being processed; retry later`, {
            provider_event_id: sealed.id,
          });
        }
        rowId = row.id;
      }
      const result = await processEvent(tx, store, sealed, actor);
      await tx.query(
        `UPDATE webhook_event SET aggregate_type = $2, aggregate_id = $3, status = $4, failure_reason = $5,
           processed_at = CASE WHEN $4 = 'received' THEN NULL ELSE now() END, updated_at = now()
         WHERE id = $1`,
        [
          rowId,
          result.aggregate?.type ?? null,
          result.aggregate?.id ?? null,
          result.followUps.length > 0 ? 'received' : result.status,
          result.reason,
        ],
      );
      return { kind: 'owned', rowId, result };
    },
  );

  if (first.kind === 'duplicate') {
    log(`[payments] webhook ${sealed.id} ${sealed.type}: duplicate (${first.status})`);
    return { kind: 'duplicate', eventId: sealed.id, type: sealed.type, status: first.status };
  }

  // ---- 4. order transitions (own transactions), then the final status ----
  let status = first.result.status;
  let reason = first.result.reason;
  if (first.result.followUps.length > 0) {
    const failure = await runFollowUps(input.client, first.result.followUps);
    if (failure) {
      status = 'failed';
      reason = failure;
    }
    await finalize(input.client, first.rowId, status, reason);
  }
  log(`[payments] webhook ${sealed.id} ${sealed.type}: ${status}${reason ? ` (${reason})` : ''}`);
  return { kind: status, eventId: sealed.id, type: sealed.type, reason, replayed: false };
}

export interface ReplayOptions {
  actor?: Actor;
  log?: (line: string) => void;
}

/**
 * Reprocesses a stored event (replay CLI, and the way an abandoned or `failed` event is finished after the
 * cause is fixed). Refuses an extract that no longer matches its `payload_hash` (seal check) — a row edited
 * by hand is not a Stripe event any more. Idempotent: the same state guards as the live path, so a replay of a
 * processed event moves nothing and writes no second event.
 */
export async function replayWebhookEvent(
  client: ScopedClient,
  providerEventId: string,
  opts: ReplayOptions = {},
): Promise<WebhookOutcome> {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const log = opts.log ?? ((line: string) => console.info(line));
  const first = await client.transaction(
    async (tx): Promise<{ rowId: string; extract: WebhookExtract; result: ProcessResult }> => {
      const r = await tx.query<WebhookEventRow>(
        `${SELECT_ROW} WHERE provider = $1 AND provider_event_id = $2 FOR UPDATE`,
        [WEBHOOK_PROVIDER, providerEventId],
      );
      const row = r.rows[0];
      if (!row) throw new AppError('not_found', `webhook event ${providerEventId} not found`);
      if (!verifySeal(row.payload, row.payload_hash)) {
        throw conflict(
          `webhook event ${providerEventId}: stored payload does not match payload_hash; refusing to replay`,
          { provider_event_id: providerEventId, status: row.status },
        );
      }
      const store = await tx.query<StoreRow>(
        `SELECT id, organization_id, legal_entity_id FROM store WHERE id = $1`,
        [row.store_id],
      );
      const result = await processEvent(tx, store.rows[0]!, row.payload, actor);
      await tx.query(
        `UPDATE webhook_event SET aggregate_type = coalesce($2, aggregate_type), aggregate_id = coalesce($3, aggregate_id),
           status = $4, failure_reason = $5, replay_count = replay_count + 1,
           processed_at = CASE WHEN $4 = 'received' THEN processed_at ELSE now() END, updated_at = now()
         WHERE id = $1`,
        [
          row.id,
          result.aggregate?.type ?? null,
          result.aggregate?.id ?? null,
          result.followUps.length > 0 ? 'received' : result.status,
          result.reason,
        ],
      );
      return { rowId: row.id, extract: row.payload, result };
    },
  );
  let status = first.result.status;
  let reason = first.result.reason;
  if (first.result.followUps.length > 0) {
    const failure = await runFollowUps(client, first.result.followUps);
    if (failure) {
      status = 'failed';
      reason = failure;
    }
    await finalize(client, first.rowId, status, reason);
  }
  log(
    `[payments] replay ${first.extract.id} ${first.extract.type}: ${status}${reason ? ` (${reason})` : ''}`,
  );
  return {
    kind: status,
    eventId: first.extract.id,
    type: first.extract.type,
    reason,
    replayed: true,
  };
}

/** Read model for the runbook / tests: one stored event by provider id. */
export async function getWebhookEvent(
  client: ScopedClient,
  providerEventId: string,
): Promise<WebhookEventRow | null> {
  const r = await client.query<WebhookEventRow>(
    `${SELECT_ROW} WHERE provider = $1 AND provider_event_id = $2`,
    [WEBHOOK_PROVIDER, providerEventId],
  );
  return r.rows[0] ?? null;
}
