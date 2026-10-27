// customer.erased in the analytics store (#623). Orders are kept, the person is not: an erased customer's identifiers
// (email_hash, customer_id, identity_id, and the customer ids a referral carries) leave every readable table and view.
//
//   * At insert time, every row the ingest classifies is checked against the erasure index and the matching fields
//     are set to null BEFORE it is buffered (`scrubEnvelope`), so a replay can never resurrect them.
//   * On customer.erased (`applyErasure`), after its own batch is acknowledged and before the commit:
//       1. the digests are recorded in `customer_erasures` and added to the index (rows classified from now on are
//          scrubbed);
//       2. the insert buffer is flushed (every row classified before 1 is now in ClickHouse);
//       3. the store's rows that still reference the customer are read FINAL, re-inserted scrubbed with a later
//          ingested_at (the ReplacingMergeTree version, so the scrubbed copy wins), and
//       4. the older versions are deleted (lightweight DELETE), so not even a non-FINAL read shows the identifier.
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
  return out ? { payload: out, changed: true } : { payload, changed: false };
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

/** Steps 1–4 above. Throws (the batch is not committed and comes back) if any step fails; every step is idempotent. */
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

  // 1. record + index
  const digests = c.identifiers.map((i) => deps.index.digest(store, i.kind, i.value));
  await deps.ch.insert({
    table: 'customer_erasures',
    format: 'JSONEachRow',
    values: digests.map((digest) => ({
      digest,
      organization_id: c.organizationId,
      event_id: c.eventId,
      erased_at: toClickHouseTime(new Date(c.erasedAt)),
    })),
  });
  deps.index.add(digests);

  // 2. nothing classified before the index changed may still be in the buffer
  await deps.flush();

  // 3. rewrite what is already stored
  const conditions = Object.entries(IDENTIFIER_FIELDS)
    .flatMap(([field, kind]) =>
      c.identifiers
        .filter((i) => i.kind === kind)
        .map((i) => `JSONExtractString(payload, '${field}') = '${i.value}'`),
    )
    .join(' OR ');
  if (conditions === '') return { digests: digests.length, rewritten: 0 };
  const scope = c.storeId
    ? `store_id = toUUID('${c.storeId}')`
    : `organization_id = toUUID('${c.organizationId}')`;
  const stored = await (
    await deps.ch.query({
      query: `SELECT topic, version, toString(event_id) AS event_id, toString(organization_id) AS organization_id,
                     if(isNull(store_id), NULL, toString(store_id)) AS store_id, aggregate_type, aggregate_id,
                     toString(occurred_at) AS occurred_at, toString(published_at) AS published_at, payload
              FROM ${table} FINAL WHERE ${scope} AND (${conditions})`,
      format: 'JSONEachRow',
    })
  ).json<Omit<RawEventRow, 'ingested_at'>>();
  if (stored.length === 0) return { digests: digests.length, rewritten: 0 };
  // one millisecond after any version a row may already have (ingested_at is the version column)
  const at = toClickHouseTime(new Date((deps.now?.() ?? new Date()).getTime() + 1));
  const rows: RawEventRow[] = stored.map((r) => ({
    ...r,
    payload: JSON.stringify(
      scrubPayload(JSON.parse(r.payload) as Record<string, unknown>, r.store_id, deps.index, c)
        .payload,
    ),
    ingested_at: at,
  }));
  await deps.ch.insert({ table, format: 'JSONEachRow', values: rows });

  // 4. the older versions go, so a non-FINAL read cannot see them either
  const ids = rows.map((r) => `toUUID('${r.event_id}')`).join(', ');
  await deps.ch.command({
    query: `DELETE FROM ${table} WHERE ${scope} AND event_id IN (${ids}) AND ingested_at < toDateTime64('${at}', 3, 'UTC')`,
  });
  return { digests: digests.length, rewritten: rows.length };
}
