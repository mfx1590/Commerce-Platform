// customer.erased in the analytics store (#623). Orders are kept, the person is not: an erased customer's identifiers
// (email_hash, customer_id, identity_id, and the customer ids a referral carries) leave every readable table and view.
//
//   * At insert time, every row the ingest classifies is checked against the erasure index and the matching fields
//     are set to null BEFORE it is buffered (`scrubPayload` in classify), so a replay can never resurrect them.
//   * On customer.erased (`applyErasure`), after its own batch is acknowledged and before the commit:
//       1. the digests are added to the index and recorded in `customer_erasures` (rows classified from now on are
//          scrubbed);
//       2. the insert buffer is flushed (every row classified before 1 is now in ClickHouse);
//       3. the store's rows that still reference the customer are read FINAL, re-inserted scrubbed with a later
//          ingested_at (the ReplacingMergeTree version, so the scrubbed copy wins), and
//       4. the older versions are deleted (lightweight DELETE) and the affected partitions are optimised FINAL, so the
//          bytes are physically gone, not only masked.
// No identifier is ever in SQL text (server-side parameters, then event ids) and query logging is off throughout.
// Money is untouched: only identifier fields change.
//
// The index holds HMAC-SHA256 digests under the erasure key, never a raw identifier (see migrations/0004).
import { createHmac } from 'node:crypto';
import type { EventEnvelopeV1Base } from '@platform/events';
import type { ChClient } from './clickhouse.js';
import { toClickHouseTime, type RawEventRow } from './rows.js';

export type IdentifierKind = 'email' | 'customer' | 'identity';

/** Payload fields that identify a customer, top-level in every schema that has one (packages/events). */
export const IDENTIFIER_FIELDS: Readonly<Record<string, IdentifierKind>> = {
  email_hash: 'email',
  customer_id: 'customer',
  identity_id: 'identity',
  referrer_customer_id: 'customer',
  referee_customer_id: 'customer',
};

/** `*` scopes an erasure to every store of the organization (a customer.erased without a store_id). */
const ANY_STORE = '*';

export class ErasureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErasureConfigError';
  }
}

export interface ErasureIndex {
  digest(store: string, kind: IdentifierKind, value: string): string;
  /** Is `value` (of `kind`) erased in `store` (or in every store)? */
  has(store: string | null, kind: IdentifierKind, value: string): boolean;
  add(digests: Iterable<string>): void;
  readonly size: number;
}

export function createErasureIndex(key: string): ErasureIndex {
  if (!key || key.length < 16)
    throw new ErasureConfigError('ANALYTICS_ERASURE_KEY must be set (at least 16 characters)');
  const set = new Set<string>();
  const digest = (store: string, kind: IdentifierKind, value: string) =>
    createHmac('sha256', key).update(`${store}:${kind}:${value}`).digest('hex');
  return {
    digest,
    has(store, kind, value) {
      return (
        (store !== null && set.has(digest(store, kind, value))) ||
        set.has(digest(ANY_STORE, kind, value))
      );
    },
    add(digests) {
      for (const d of digests) set.add(d);
    },
    get size() {
      return set.size;
    },
  };
}

/** Loads every recorded erasure (at ingest start). */
export async function loadErasures(ch: ChClient, index: ErasureIndex): Promise<number> {
  const rows = await (
    await ch.query({ query: 'SELECT digest FROM customer_erasures FINAL', format: 'JSONEachRow' })
  ).json<{ digest: string }>();
  index.add(rows.map((r) => r.digest));
  return rows.length;
}

/** The payload with every identifier field the index says is erased set to null; `changed` false = untouched. */
export function scrubPayload(
  payload: Record<string, unknown>,
  store: string | null,
  index: ErasureIndex,
  extra?: ErasedCustomer,
): { payload: Record<string, unknown>; changed: boolean } {
  let out: Record<string, unknown> | null = null;
  for (const [field, kind] of Object.entries(IDENTIFIER_FIELDS)) {
    const v = payload[field];
    if (typeof v !== 'string' || v === '') continue;
    const erased = index.has(store, kind, v) || (extra !== undefined && matches(extra, kind, v));
    if (!erased) continue;
    out ??= { ...payload };
    out[field] = null;
  }
  // customer.export_requested v2 / customer.export_ready: requested_by is the CUSTOMER id when requested_by_type is
  // 'customer' (a staff user id otherwise, which stays)
  const by = payload.requested_by;
  if (
    payload.requested_by_type === 'customer' &&
    typeof by === 'string' &&
    by !== '' &&
    (index.has(store, 'customer', by) || (extra !== undefined && matches(extra, 'customer', by)))
  ) {
    out ??= { ...payload };
    out.requested_by = null;
  }
  return out ? { payload: out, changed: true } : { payload, changed: false };
}

/** A customer event's aggregate_id is the customer id: erased like the payload field (an empty string, the column is not nullable). */
export function scrubAggregateId(
  aggregateType: string,
  aggregateId: string,
  store: string | null,
  index: ErasureIndex,
  extra?: ErasedCustomer,
): string {
  if (aggregateType !== 'customer' || aggregateId === '') return aggregateId;
  for (const kind of ['customer', 'identity'] as const)
    if (
      index.has(store, kind, aggregateId) ||
      (extra !== undefined && matches(extra, kind, aggregateId))
    )
      return '';
  return aggregateId;
}

export interface ErasedCustomer {
  organizationId: string;
  /** null = every store of the organization. */
  storeId: string | null;
  eventId: string;
  erasedAt: string;
  identifiers: { kind: IdentifierKind; value: string }[];
}

function matches(c: ErasedCustomer, kind: IdentifierKind, value: string): boolean {
  return c.identifiers.some((i) => i.kind === kind && i.value === value);
}

/** The identifiers a customer.erased (v1: customer_id + identity_id; v2: + email_hash) names. */
export function erasedCustomerOf(e: EventEnvelopeV1Base): ErasedCustomer | null {
  if (e.topic !== 'customer.erased') return null;
  const p = e.payload as unknown as Record<string, unknown>;
  const identifiers: ErasedCustomer['identifiers'] = [];
  for (const [field, kind] of [
    ['customer_id', 'customer'],
    ['identity_id', 'identity'],
    ['email_hash', 'email'],
  ] as const) {
    const v = p[field];
    if (typeof v === 'string' && v !== '') identifiers.push({ kind, value: v });
  }
  return {
    organizationId: e.organization_id,
    storeId: e.store_id,
    eventId: e.event_id,
    erasedAt: typeof p.erased_at === 'string' ? p.erased_at : e.occurred_at,
    identifiers,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE = /^[0-9A-Za-z_.:@+-]+$/; // identifiers are uuids and hex hashes; anything else is refused, never inlined

export interface ApplyErasureDeps {
  ch: ChClient;
  index: ErasureIndex;
  /** The ingest's insert buffer: everything classified before the index changed must reach ClickHouse first. */
  flush: () => Promise<void>;
  now?: () => Date;
  table?: string;
}

export interface ErasureResult {
  digests: number;
  rewritten: number;
}

/**
 * Every erasure statement runs with query logging OFF: an identifier in a statement (or in its parameters) would
 * otherwise land in system.query_log for its TTL. Identifiers never appear in the SQL text either: they travel as
 * server-side parameters, and every later statement works on event ids only.
 */
export const ERASURE_SETTINGS = { log_queries: 0 } as const;

const PARTITION_ID = /^[0-9a-z_]+$/;

/** Steps 1–5. Throws (the batch is not committed and comes back) if any step fails; every step is idempotent. */
export async function applyErasure(
  deps: ApplyErasureDeps,
  c: ErasedCustomer,
): Promise<ErasureResult> {
  const table = deps.table ?? 'raw_events';
  const store = c.storeId ?? ANY_STORE;
  if (c.identifiers.some((i) => !SAFE.test(i.value)) || (c.storeId && !UUID.test(c.storeId)))
    throw new ErasureConfigError(
      'customer.erased carries an identifier that is not a uuid or hash',
    );

  // 1 + 2, atomically with respect to classification: the index changes and the buffer is cut IN THE SAME
  // SYNCHRONOUS TICK. classify → buffer is synchronous too (processBatch), so every row classified before this line
  // is in the buffer being flushed, and every row classified after it is scrubbed: no row can fall between the two.
  const digests = c.identifiers.map((i) => deps.index.digest(store, i.kind, i.value));
  deps.index.add(digests);
  const flushed = deps.flush();
  await Promise.all([
    flushed,
    deps.ch.insert({
      table: 'customer_erasures',
      format: 'JSONEachRow',
      clickhouse_settings: ERASURE_SETTINGS,
      values: digests.map((digest) => ({
        digest,
        organization_id: c.organizationId,
        event_id: c.eventId,
        erased_at: toClickHouseTime(new Date(c.erasedAt)),
      })),
    }),
  ]);

  // 3. which stored rows (any version, so non-FINAL) still name the customer: identifiers as parameters only
  const params: Record<string, unknown> = {
    org: c.organizationId,
    store: c.storeId,
  };
  const conditions: string[] = [];
  for (const [field, kind] of Object.entries(IDENTIFIER_FIELDS))
    c.identifiers
      .filter((i) => i.kind === kind)
      .forEach((i) => {
        const name = `v${conditions.length}`;
        params[name] = i.value;
        conditions.push(`JSONExtractString(payload, '${field}') = {${name}:String}`);
      });
  // an export requested by the customer themself names them in requested_by
  c.identifiers
    .filter((i) => i.kind === 'customer')
    .forEach((i) => {
      const name = `v${conditions.length}`;
      params[name] = i.value;
      conditions.push(
        `(JSONExtractString(payload, 'requested_by_type') = 'customer' AND JSONExtractString(payload, 'requested_by') = {${name}:String})`,
      );
    });
  // a customer event's aggregate_id IS the customer id
  c.identifiers
    .filter((i) => i.kind === 'customer' || i.kind === 'identity')
    .forEach((i) => {
      const name = `v${conditions.length}`;
      params[name] = i.value;
      conditions.push(`(aggregate_type = 'customer' AND aggregate_id = {${name}:String})`);
    });
  if (conditions.length === 0) return { digests: digests.length, rewritten: 0 };
  const scope = c.storeId ? 'store_id = {store:UUID}' : 'organization_id = {org:UUID}';
  const hits = await (
    await deps.ch.query({
      query: `SELECT DISTINCT toString(event_id) AS id, _partition_id AS part FROM ${table}
              WHERE ${scope} AND (${conditions.join(' OR ')})`,
      format: 'JSONEachRow',
      query_params: params,
      clickhouse_settings: ERASURE_SETTINGS,
      // the identifiers travel in the multipart body: in the URL (param_v0=<hash>) they would reach HTTP trace logs
      // and any proxy or load-balancer access log, which log_queries = 0 does not cover
      use_multipart_params: true,
    })
  ).json<{ id: string; part: string }>();
  if (hits.length === 0) return { digests: digests.length, rewritten: 0 };
  const ids = [...new Set(hits.map((h) => h.id))];
  const parts = [...new Set(hits.map((h) => h.part))];

  // 4. re-insert the latest version of each, scrubbed, one millisecond after any version it may have
  const stored = await (
    await deps.ch.query({
      // raw columns, NO aliases: an alias named like a column (toString(event_id) AS event_id) would shadow it in the
      // WHERE and match nothing (JSON renders UUIDs and DateTime64 as strings anyway)
      query: `SELECT topic, version, event_id, organization_id, store_id, aggregate_type, aggregate_id, occurred_at,
                     published_at, payload
              FROM ${table} FINAL WHERE event_id IN {ids:Array(UUID)}`,
      format: 'JSONEachRow',
      query_params: { ids },
      clickhouse_settings: ERASURE_SETTINGS,
    })
  ).json<Omit<RawEventRow, 'ingested_at'>>();
  const at = toClickHouseTime(new Date((deps.now?.() ?? new Date()).getTime() + 1));
  // never delete what was not rewritten: every matched event must come back scrubbed first
  if (new Set(stored.map((r) => r.event_id)).size !== ids.length)
    throw new ErasureConfigError(
      `erasure: matched ${ids.length} events but read back ${stored.length}; nothing deleted`,
    );
  const rows: RawEventRow[] = stored.map((r) => ({
    ...r,
    aggregate_id: scrubAggregateId(r.aggregate_type, r.aggregate_id, r.store_id, deps.index, c),
    payload: JSON.stringify(
      scrubPayload(JSON.parse(r.payload) as Record<string, unknown>, r.store_id, deps.index, c)
        .payload,
    ),
    ingested_at: at,
  }));
  await deps.ch.insert({
    table,
    format: 'JSONEachRow',
    values: rows,
    clickhouse_settings: ERASURE_SETTINGS,
  });

  // 5. hide the older versions at once (lightweight DELETE), then rewrite the affected partitions so the bytes are
  //    physically gone (a lightweight DELETE only masks rows until a merge); bounded: only these partitions
  await deps.ch.command({
    query: `DELETE FROM ${table} WHERE event_id IN {ids:Array(UUID)} AND ingested_at < {at:DateTime64(3, 'UTC')}`,
    query_params: { ids, at },
    clickhouse_settings: ERASURE_SETTINGS,
  });
  for (const p of parts) {
    if (!PARTITION_ID.test(p)) throw new ErasureConfigError(`unexpected partition id ${p}`);
    await deps.ch.command({
      query: `OPTIMIZE TABLE ${table} PARTITION ID '${p}' FINAL`,
      clickhouse_settings: ERASURE_SETTINGS,
    });
  }
  return { digests: digests.length, rewritten: rows.length };
}
