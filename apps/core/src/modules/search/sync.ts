// Full reindex and incremental sync of one store's index (issue #134).
//
// Full: snapshot the store's outbox position, stream every published product into the index in batches, delete
// records that are no longer published, then push the position as the cursor. Incremental: read outbox rows
// (`product.published|updated|archived`) with `seq > cursor` for the store, re-read the touched products from
// the database (the payload is never trusted as the record source), upsert the ones that are published and
// sellable, delete the rest, advance the cursor. Both are idempotent: running them twice yields the same index.
//
// The cursor lives in the index settings (`userData.outbox_cursor`) rather than in a table: the db schema is
// frozen, no other module's table is written, and an index that is dropped or rebuilt cannot resume from a
// stale position — it must be reindexed in full, which is the only correct thing to do anyway.
import type { Queryable, ScopedClient, TenantContext } from '@platform/db';
import { AppError, forbidden } from '../../lib/errors';
import { loadSearchRecords } from './records';
import {
  CURSOR_KEY,
  indexNameFor,
  primarySettings,
  REPLICA_SORTS,
  replicaNameFor,
  replicaSettings,
} from './settings';
import {
  SYNC_TOPICS,
  type IndexClient,
  type ReindexResult,
  type StoreIndexTarget,
  type SyncResult,
} from './types';

export interface SyncOptions {
  /** Records per index batch (full) / outbox rows per run (incremental). */
  batchSize?: number;
  log?: (msg: string) => void;
}

const DEFAULT_BATCH = 500;

/** A store-scoped client may only index its own store; an organization client may index any store. */
function assertScoped(client: ScopedClient, storeId: string): void {
  if (client.scope === 'store') {
    const ctx = client.context as TenantContext;
    if (!ctx.storeIds.includes(storeId))
      throw forbidden(`search: client is not scoped to store ${storeId}`);
  }
}

/** Current outbox cursor of an index, or null when the index was never fully reindexed. */
export async function readCursor(index: IndexClient, indexName: string): Promise<number | null> {
  const settings = await index.getSettings(indexName);
  const raw = settings.userData?.[CURSOR_KEY];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

async function writeCursor(
  index: IndexClient,
  indexName: string,
  cursor: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const settings = await index.getSettings(indexName);
  await index.setSettings(indexName, {
    userData: { ...(settings.userData ?? {}), ...extra, [CURSOR_KEY]: cursor },
  });
}

/**
 * Pushes the primary settings (with the replica list) and each replica's ranking. Safe to repeat; called by
 * every full reindex so a settings change in code reaches every store on its next reindex.
 */
export async function ensureIndexSettings(
  index: IndexClient,
  store: StoreIndexTarget,
): Promise<string> {
  const name = indexNameFor(store);
  await index.setSettings(name, primarySettings(store));
  for (const sort of REPLICA_SORTS) {
    await index.setSettings(replicaNameFor(name, sort), replicaSettings(store, sort));
  }
  return name;
}

async function outboxPosition(tx: Queryable, storeId: string): Promise<number> {
  const r = await tx.query<{ seq: string }>(
    `SELECT coalesce(max(seq), 0)::text AS seq FROM outbox WHERE store_id = $1`,
    [storeId],
  );
  return Number(r.rows[0]?.seq ?? 0);
}

/** Rebuilds the store's index from the catalog. Never clears the index: readers see no gap. */
export async function fullReindex(
  client: ScopedClient,
  store: StoreIndexTarget,
  index: IndexClient,
  opts: SyncOptions = {},
): Promise<ReindexResult> {
  assertScoped(client, store.id);
  const batch = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const log = opts.log ?? (() => {});
  const indexName = await ensureIndexSettings(index, store);

  const indexed = new Set<string>();
  const cursor = await client.transaction(async (tx) => {
    // Position first, products second: anything that changes while we read is replayed by the next sync.
    const position = await outboxPosition(tx, store.id);
    for (let offset = 0; ; offset += batch) {
      const records = await loadSearchRecords(tx, store.id, { limit: batch, offset });
      if (records.length === 0) break;
      for (const r of records) {
        if (r.store_id !== store.id)
          throw new AppError('internal', 'search: record of another store in reindex batch');
        indexed.add(r.objectID);
      }
      await index.saveObjects(indexName, records);
      log(`search: ${store.code} indexed ${indexed.size}`);
      if (records.length < batch) break;
    }
    return position;
  });

  const existing = await index.browseObjectIDs(indexName);
  const stale = existing.filter((id) => !indexed.has(id));
  if (stale.length > 0) {
    for (let i = 0; i < stale.length; i += batch) {
      await index.deleteObjects(indexName, stale.slice(i, i + batch));
    }
  }
  await writeCursor(index, indexName, cursor, { reindexed_at: new Date().toISOString() });
  log(`search: ${store.code} full reindex done (${indexed.size} records, ${stale.length} removed)`);
  return { indexName, indexed: indexed.size, removed: stale.length, cursor };
}

interface OutboxRow {
  seq: string;
  topic: string;
  aggregate_id: string;
  payload: { product_id?: string } | null;
}

/**
 * Applies the outbox rows after the index cursor (at most `batchSize`). Returns `processed === batchSize` when
 * more may be waiting — loop until it is smaller. Throws `conflict` when the index has no cursor yet (run a
 * full reindex first; replaying the whole outbox would still miss products that were never evented, such as
 * seeded ones).
 */
export async function syncFromOutbox(
  client: ScopedClient,
  store: StoreIndexTarget,
  index: IndexClient,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  assertScoped(client, store.id);
  const batch = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const log = opts.log ?? (() => {});
  const indexName = indexNameFor(store);
  const cursor = await readCursor(index, indexName);
  if (cursor === null)
    throw new AppError(
      'conflict',
      `search: index ${indexName} has no outbox cursor — run a full reindex first`,
      { index: indexName, store_code: store.code },
    );

  return client.transaction(async (tx) => {
    const rows = await tx.query<OutboxRow>(
      `SELECT seq::text, topic, aggregate_id, payload FROM outbox
       WHERE store_id = $1 AND topic = ANY($2) AND seq > $3
       ORDER BY seq LIMIT $4`,
      [store.id, [...SYNC_TOPICS], cursor, batch],
    );
    if (rows.rows.length === 0) return { processed: 0, upserted: 0, deleted: 0, cursor };

    const productIds = [...new Set(rows.rows.map((r) => r.payload?.product_id ?? r.aggregate_id))];
    const records = await loadSearchRecords(tx, store.id, { productIds });
    const present = new Set(records.map((r) => r.objectID));
    const toDelete = productIds.filter((id) => !present.has(id));

    if (records.length > 0) await index.saveObjects(indexName, records);
    if (toDelete.length > 0) await index.deleteObjects(indexName, toDelete);

    const last = Number(rows.rows[rows.rows.length - 1]!.seq);
    await writeCursor(index, indexName, last);
    log(
      `search: ${store.code} sync ${rows.rows.length} events → ${records.length} upserted, ${toDelete.length} deleted, cursor ${last}`,
    );
    return {
      processed: rows.rows.length,
      upserted: records.length,
      deleted: toDelete.length,
      cursor: last,
    };
  });
}

/** Loops `syncFromOutbox` until a run returns fewer rows than the batch. */
export async function syncUntilCaughtUp(
  client: ScopedClient,
  store: StoreIndexTarget,
  index: IndexClient,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const batch = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const total: SyncResult = { processed: 0, upserted: 0, deleted: 0, cursor: 0 };
  for (;;) {
    const r = await syncFromOutbox(client, store, index, { ...opts, batchSize: batch });
    total.processed += r.processed;
    total.upserted += r.upserted;
    total.deleted += r.deleted;
    total.cursor = r.cursor;
    if (r.processed < batch) return total;
  }
}
