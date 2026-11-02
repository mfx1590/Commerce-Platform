// Replay from the outbox (issue #534): republishes PUBLISHED outbox rows of one topic to the bus. The outbox is
// the source of truth; the bus (30-day topics in particular) is a delivery window. A replay is safe for every
// consumer: the message carries the same outbox_id, so a group that handled the rows dedupes them, and a fresh
// group rebuilds from them. Nothing here writes to the database: published_at, attempts and last_error stay as
// the relay left them. Two extra headers mark a replayed message: `replay: 1` and `replayed_at`.
//
// Erasure (#629): the outbox keeps every payload, so a replay would hand an erased customer's ids back to the bus.
// Before it sends, the replay reads the erased customers from the outbox's own customer.erased rows (published or
// not; they are never pruned) and, per store, SKIPS every row of a topic that names one: order.placed, customer.*,
// cart.abandoned, review.published, referral.converted. customer.erased itself is sent whole. Skipping order.placed
// means a ledger rebuilt from scratch misses those orders until order.placed@2 (#696, email_hash nullable) lets the
// replay send them without the ids; an existing ledger keeps them (idempotent by source_event_id).
import {
  createValidator,
  envelopeToMessage,
  EVENT_TOPICS,
  outboxRowToEnvelope,
  type OutboxRow,
  type RelayMessage,
  type Validator,
} from '@platform/events';
import type { ScopedClient } from '@platform/db';
import { errorClass, RelayPublishTimeout, type RelayPublisher } from './relay';

export const REPLAY_PRODUCER = 'core-outbox-replay/1';
export const HEADER_REPLAY = 'replay';
export const HEADER_REPLAYED_AT = 'replayed_at';
export const DEFAULT_REPLAY_BATCH = 500;

export interface ReplayOptions {
  organizationId: string;
  /** The event topic (`order.placed`); must be one of EVENT_TOPICS. */
  topic: string;
  /** `occurred_at >= from` */
  from?: Date;
  /** `occurred_at < to` */
  to?: Date;
  /** Only rows with `seq > afterSeq`: the resume point a stopped replay printed (`last_seq`). */
  afterSeq?: string;
  /** Only this store's rows. */
  storeId?: string;
  /** Rows per send. Default 500. */
  batchSize?: number;
  /** Count and describe; publish nothing. */
  dryRun?: boolean;
  /** Tests only: published topic = prefix + topic. */
  topicPrefix?: string;
  /** `topic@version` → schema registry id (the `schema_id` header), like the relay. */
  schemaIds?: Record<string, number>;
  /** Per-batch send deadline. Default 15 s. */
  publishTimeoutMs?: number;
  log?: (line: ReplayBatchLine) => void;
  now?: () => Date;
}

type Payload = Record<string, unknown>;

/** Where a topic's payload names a customer: the customer ids and the e-mail hashes it carries. */
interface ErasureRule {
  customerIds: (p: Payload) => unknown[];
  emailHashes: (p: Payload) => unknown[];
}

const byCustomer = (p: Payload): unknown[] => [p.customer_id];
const byHash = (p: Payload): unknown[] => [p.email_hash];
const none = (): unknown[] => [];

/**
 * Every topic whose payload names a customer (#629). A replay skips the rows that name an erased customer of their
 * store. customer.erased is not here: it is the erasure itself, and every consumer needs it.
 * replay-erasure.test.ts fails when a schema with a customer id or an e-mail hash has no entry.
 */
export const ERASURE_RULES: Readonly<Record<string, ErasureRule>> = {
  'order.placed': { customerIds: byCustomer, emailHashes: byHash },
  'cart.abandoned': { customerIds: byCustomer, emailHashes: byHash },
  'customer.created': { customerIds: byCustomer, emailHashes: byHash },
  'customer.updated': { customerIds: byCustomer, emailHashes: byHash },
  'customer.export_requested': { customerIds: byCustomer, emailHashes: none },
  'customer.export_ready': { customerIds: byCustomer, emailHashes: none },
  'review.published': { customerIds: byCustomer, emailHashes: none },
  'referral.converted': {
    customerIds: (p) => [p.referrer_customer_id, p.referee_customer_id],
    emailHashes: none,
  },
};

/** The erased customers of one replay, per store. */
export interface ErasedSet {
  /** customer.erased rows read (one per erased customer and store). */
  readonly customers: number;
  /** `<store>|c:<customer_id>` and `<store>|h:<email_hash>` */
  readonly keys: ReadonlySet<string>;
}

const erasedKey = (storeId: string | null, kind: 'c' | 'h', id: unknown): string | null =>
  typeof id === 'string' && id !== '' ? `${storeId ?? 'organization'}|${kind}:${id}` : null;

/** Reads the erased customers from the outbox's customer.erased rows (v1 carries no email_hash; v2 does). */
export async function loadErasedSet(client: ScopedClient, storeId?: string): Promise<ErasedSet> {
  const r = await client.query<{
    store_id: string | null;
    customer_id: string | null;
    email_hash: string | null;
  }>(
    `SELECT store_id, payload->>'customer_id' AS customer_id, payload->>'email_hash' AS email_hash
     FROM outbox WHERE topic = 'customer.erased'${storeId ? ' AND store_id = $1' : ''}`,
    storeId ? [storeId] : [],
  );
  const keys = new Set<string>();
  for (const row of r.rows) {
    for (const k of [
      erasedKey(row.store_id, 'c', row.customer_id),
      erasedKey(row.store_id, 'h', row.email_hash),
    ])
      if (k) keys.add(k);
  }
  return { customers: r.rows.length, keys };
}

/** Whether a row of `topic` names an erased customer of its own store. */
export function namesErased(
  topic: string,
  storeId: string | null,
  payload: Payload,
  erased: ErasedSet,
): boolean {
  const rule = ERASURE_RULES[topic];
  if (!rule || erased.keys.size === 0) return false;
  return [
    ...rule.customerIds(payload).map((id) => erasedKey(storeId, 'c', id)),
    ...rule.emailHashes(payload).map((h) => erasedKey(storeId, 'h', h)),
  ].some((k) => k !== null && erased.keys.has(k));
}

export interface ReplayBatchLine {
  replay: 'outbox';
  organization_id: string;
  topic: string;
  batch: number;
  rows: number;
  /** The seq of the last row in this batch: the resume point (`--after-seq <last_seq>`). */
  last_seq: string;
  duration_ms: number;
}

export interface ReplaySummary {
  replay: 'outbox';
  organization_id: string;
  topic: string;
  dry_run: boolean;
  rows: number;
  published: number;
  batches: number;
  per_store: Record<string, number>;
  oldest_occurred_at: string | null;
  newest_occurred_at: string | null;
  /** customer.erased rows in scope (#629); 0 for a topic that names no customer. */
  erased_customers: number;
  /** Rows not sent because they name an erased customer, per event type (`{ "order.placed": 2 }`); empty for a topic that names no customer. */
  erased_skipped: Record<string, number>;
  duration_ms: number;
}

type Row = OutboxRow & { seq: string };

let validator: Validator | undefined;
const getValidator = (): Validator => (validator ??= createValidator());

function where(opts: ReplayOptions): { sql: string; params: unknown[] } {
  const params: unknown[] = [opts.topic];
  const parts = ['topic = $1', 'published_at IS NOT NULL'];
  if (opts.from) {
    params.push(opts.from);
    parts.push(`occurred_at >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    parts.push(`occurred_at < $${params.length}`);
  }
  if (opts.storeId) {
    params.push(opts.storeId);
    parts.push(`store_id = $${params.length}`);
  }
  if (opts.afterSeq !== undefined) {
    // WHERE sees the table column (an output alias is visible to ORDER BY only); compared as bigint, not text
    params.push(opts.afterSeq);
    parts.push(`seq > $${params.length}::bigint`);
  }
  return { sql: parts.join(' AND '), params };
}

/** Counts and the occurred_at range of what a replay would send (the dry run; also the first step of a real one). */
export async function describeReplay(
  client: ScopedClient,
  opts: ReplayOptions,
): Promise<
  Pick<ReplaySummary, 'rows' | 'per_store' | 'oldest_occurred_at' | 'newest_occurred_at'>
> {
  const w = where(opts);
  const r = await client.query<{
    store_id: string | null;
    n: string;
    oldest: Date | null;
    newest: Date | null;
  }>(
    `SELECT store_id, count(*)::text AS n, min(occurred_at) AS oldest, max(occurred_at) AS newest
     FROM outbox WHERE ${w.sql} GROUP BY store_id ORDER BY store_id NULLS LAST`,
    w.params,
  );
  const per_store: Record<string, number> = {};
  let rows = 0;
  let oldest: Date | null = null;
  let newest: Date | null = null;
  for (const row of r.rows) {
    per_store[row.store_id ?? 'organization'] = Number(row.n);
    rows += Number(row.n);
    if (row.oldest && (!oldest || row.oldest < oldest)) oldest = row.oldest;
    if (row.newest && (!newest || row.newest > newest)) newest = row.newest;
  }
  return {
    rows,
    per_store,
    oldest_occurred_at: oldest ? new Date(oldest).toISOString() : null,
    newest_occurred_at: newest ? new Date(newest).toISOString() : null,
  };
}

/**
 * Republishes the matching rows in `seq` order, `batchSize` at a time, one send per batch (the whole batch is
 * one topic, so per-partition order is the seq order). A send that fails stops the replay: the summary so far is
 * in the error with the last published `seq`, and the operator reruns with `--after-seq <last_seq>` to resume (a full
 * rerun is safe too: consumers dedupe on outbox_id).
 */
export async function replayOutbox(
  client: ScopedClient,
  publisher: RelayPublisher,
  opts: ReplayOptions,
): Promise<ReplaySummary> {
  if (!(EVENT_TOPICS as readonly string[]).includes(opts.topic)) {
    throw new Error(`unknown topic ${opts.topic} (not in packages/events EVENT_TOPICS)`);
  }
  const now = opts.now ?? (() => new Date());
  const started = now();
  const batchSize = opts.batchSize ?? DEFAULT_REPLAY_BATCH;
  const prefix = opts.topicPrefix ?? '';
  const publishTimeoutMs = opts.publishTimeoutMs ?? 15_000;
  const log = opts.log ?? ((line: ReplayBatchLine) => console.info(JSON.stringify(line)));
  const described = await describeReplay(client, opts);
  const rule = ERASURE_RULES[opts.topic];
  // only a topic that names a customer needs the erased set; customer.erased itself is always sent whole
  const erased: ErasedSet = rule
    ? await loadErasedSet(client, opts.storeId)
    : { customers: 0, keys: new Set() };
  const summary: ReplaySummary = {
    replay: 'outbox',
    organization_id: opts.organizationId,
    topic: opts.topic,
    dry_run: opts.dryRun === true,
    ...described,
    erased_customers: erased.customers,
    erased_skipped: rule ? { [opts.topic]: 0 } : {},
    published: 0,
    batches: 0,
    duration_ms: 0,
  };
  if (opts.dryRun || described.rows === 0) {
    summary.duration_ms = now().getTime() - started.getTime();
    return summary;
  }

  const v = getValidator();
  const w = where(opts);
  let lastSeq = '0';
  for (;;) {
    const batchStarted = now();
    const rows = (
      await client.query<Row>(
        `SELECT id, organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload, headers,
                occurred_at, seq::text AS seq
         FROM outbox o WHERE ${w.sql} AND o.seq > $${w.params.length + 1} ORDER BY o.seq LIMIT $${w.params.length + 2}`,
        // o.seq qualified: a bare ORDER BY seq would pick the text alias of the select list and sort "10" before "2"
        [...w.params, lastSeq, batchSize],
      )
    ).rows;
    if (rows.length === 0) break;
    const replayedAt = now().toISOString();
    const messages: RelayMessage[] = [];
    let skipped = 0;
    for (const row of rows) {
      const envelope = outboxRowToEnvelope(row);
      const check = v.validateEnvelope(envelope);
      if (!check.ok)
        throw new Error(`outbox row ${row.id} no longer validates: ${check.errors.join('; ')}`);
      if (namesErased(row.topic, row.store_id, envelope.payload as Payload, erased)) {
        skipped += 1;
        continue;
      }
      const m = envelopeToMessage(envelope, REPLAY_PRODUCER, {
        schemaId: opts.schemaIds?.[`${row.topic}@${row.version}`],
      });
      m.headers[HEADER_REPLAY] = '1';
      m.headers[HEADER_REPLAYED_AT] = replayedAt;
      messages.push(m);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        // a batch whose every row was skipped sends nothing; the resume point still moves past it
        messages.length > 0
          ? publisher.send(`${prefix}${opts.topic}`, messages)
          : Promise.resolve(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RelayPublishTimeout(opts.topic, publishTimeoutMs)),
            publishTimeoutMs,
          );
        }),
      ]);
    } catch (err) {
      throw new Error(
        `replay of ${opts.topic} stopped after ${summary.published} row(s) in ${summary.batches} batch(es) (last_seq ${lastSeq}; resume with --after-seq ${lastSeq}): ${errorClass(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    lastSeq = rows[rows.length - 1]!.seq;
    summary.published += messages.length;
    if (rule)
      summary.erased_skipped[opts.topic] = (summary.erased_skipped[opts.topic] ?? 0) + skipped;
    summary.batches += 1;
    log({
      replay: 'outbox',
      organization_id: opts.organizationId,
      topic: opts.topic,
      batch: summary.batches,
      rows: rows.length,
      last_seq: lastSeq,
      duration_ms: now().getTime() - batchStarted.getTime(),
    });
    if (rows.length < batchSize) break;
  }
  summary.duration_ms = now().getTime() - started.getTime();
  return summary;
}
