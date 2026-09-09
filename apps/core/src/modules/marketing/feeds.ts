// Product feed definitions and the publish job (issue #146).
//
// Publishing is: build the rows from the catalogue → validate them per channel → render the file → store it →
// record what happened. The file is the artifact; the row is the record of it.
//
// **Idempotency (manager decision 2026-09-08).** The hash is taken from the *stored artifact*, not from a column:
// `product_feed` has no hash or metadata column and `packages/db` is frozen, so hashing what is already stored
// avoids a CONTRACT CHANGE entirely. Re-publishing identical bytes writes no file and emits no `feed.published`;
// `last_published_at` therefore means "when the file last changed", which is the question a channel actually
// asks. `status`, `url`, `item_count` and `errors` always reflect the latest run, changed or not, so the admin
// screen never shows a stale verdict. The renderers are deterministic (no timestamps) to make this work.
import type { Queryable, ScopedClient } from '@platform/db';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { conflict, mapPgError, notFound, validationError } from '../../lib/errors';
import { buildFeedItems } from './feed-items';
import { renderFeed } from './feed-render';
import { publishableItems, validateItems } from './feed-validation';
import { feedKey, getFeedStorage, sha256 } from './storage';
import {
  FEED_CHANNELS,
  FEED_EXTENSION,
  FEED_INPUT_STATUSES,
  FEED_STATUSES,
  RENDERABLE_CHANNELS,
  type FeedChannel,
  type FeedError,
  type FeedItem,
  type FeedListQuery,
  type FeedStatus,
  type ProductFeed,
  type ProductFeedInput,
  type ProductFeedRow,
} from './feed-types';
import type { Page } from './types';

const CURRENCY = /^[A-Z]{3}$/;

const COLUMNS = `id, organization_id, store_id, name, channel, locale, currency, filters, mapping, url, status,
  last_published_at, item_count, errors, created_at, updated_at`;

export function toFeed(row: ProductFeedRow): ProductFeed {
  return {
    id: row.id,
    store_id: row.store_id,
    name: row.name,
    channel: row.channel,
    locale: row.locale,
    currency: row.currency,
    filters: row.filters ?? {},
    mapping: row.mapping ?? {},
    url: row.url,
    status: row.status,
    last_published_at: row.last_published_at ? row.last_published_at.toISOString() : null,
    item_count: row.item_count,
    errors: row.errors ?? [],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

interface StoreFacts {
  code: string;
  currencies: string[];
}

async function storeFacts(q: Queryable, storeId: string): Promise<StoreFacts> {
  const store = await q.query<{ code: string }>(`SELECT code FROM store WHERE id = $1`, [storeId]);
  if (!store.rows[0]) throw notFound('store', storeId);
  const currencies = await q.query<{ currency: string }>(
    `SELECT currency FROM store_currency WHERE store_id = $1`,
    [storeId],
  );
  return {
    code: store.rows[0].code,
    currencies: currencies.rows.map((c) => c.currency.trim().toUpperCase()),
  };
}

interface NormalisedFeed {
  name: string;
  channel: FeedChannel;
  locale: string;
  currency: string;
  filters: Record<string, unknown>;
  mapping: Record<string, unknown>;
  status: FeedStatus;
}

/**
 * Validates a `ProductFeedInput`. `currency` must be one of the store's ("Must be one of the store's currencies"
 * in the contract) — a feed quoting a currency the store does not sell would produce a file the channel accepts
 * and no customer can buy from.
 */
export function normaliseFeedInput(input: ProductFeedInput, store: StoreFacts): NormalisedFeed {
  const problems: Record<string, string> = {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') problems.name = 'non-empty string';
  if (!FEED_CHANNELS.includes(input.channel)) {
    problems.channel = `one of ${FEED_CHANNELS.join(', ')}`;
  }
  const locale = typeof input.locale === 'string' ? input.locale.trim() : '';
  if (locale === '') problems.locale = 'non-empty string';

  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  if (!CURRENCY.test(currency)) problems.currency = 'ISO-4217 code, upper case';
  else if (!store.currencies.includes(currency)) {
    problems.currency = `not sold by this store (has ${store.currencies.join(', ') || 'none'})`;
  }

  const status = (input.status ?? 'draft') as FeedStatus;
  if (!FEED_INPUT_STATUSES.includes(status)) {
    problems.status = `one of ${FEED_INPUT_STATUSES.join(', ')} (error is set by publishing)`;
  }

  const filters = input.filters ?? {};
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    problems.filters = 'object';
  }
  const mapping = input.mapping ?? {};
  if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
    problems.mapping = 'object';
  }

  if (Object.keys(problems).length) throw validationError('invalid feed', problems);
  return {
    name,
    channel: input.channel,
    locale,
    currency,
    filters: filters as Record<string, unknown>,
    mapping: mapping as Record<string, unknown>,
    status,
  };
}

export async function listFeeds(
  client: ScopedClient,
  storeId: string,
  query: FeedListQuery = {},
): Promise<Page<ProductFeed>> {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const params: unknown[] = [storeId];
  const where = ['store_id = $1'];
  if (query.channel) {
    if (!FEED_CHANNELS.includes(query.channel)) {
      throw validationError('invalid channel', { channel: `one of ${FEED_CHANNELS.join(', ')}` });
    }
    params.push(query.channel);
    where.push(`channel = $${params.length}`);
  }
  if (query.status) {
    if (!FEED_STATUSES.includes(query.status)) {
      throw validationError('invalid status', { status: `one of ${FEED_STATUSES.join(', ')}` });
    }
    params.push(query.status);
    where.push(`status = $${params.length}`);
  }
  const filter = where.join(' AND ');
  const counted = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM product_feed WHERE ${filter}`,
    params,
  );
  const rows = await client.query<ProductFeedRow>(
    `SELECT ${COLUMNS} FROM product_feed WHERE ${filter}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, (page - 1) * limit],
  );
  return {
    page,
    limit,
    total: Number(counted.rows[0]?.total ?? 0),
    items: rows.rows.map(toFeed),
  };
}

async function loadRow(q: Queryable, storeId: string, id: string): Promise<ProductFeedRow> {
  const res = await q.query<ProductFeedRow>(
    `SELECT ${COLUMNS} FROM product_feed WHERE store_id = $1 AND id = $2`,
    [storeId, id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('feed', id);
  return row;
}

export async function getFeed(
  client: ScopedClient,
  storeId: string,
  id: string,
): Promise<ProductFeed> {
  return toFeed(await loadRow(client, storeId, id));
}

export async function createFeed(
  client: ScopedClient,
  storeId: string,
  input: ProductFeedInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ProductFeed> {
  const organizationId = client.context.organizationId;
  const store = await storeFacts(client, storeId);
  const v = normaliseFeedInput(input, store);
  return client.transaction(async (tx) => {
    const inserted = await tx
      .query<ProductFeedRow>(
        `INSERT INTO product_feed (organization_id, store_id, name, channel, locale, currency, filters, mapping,
                                   status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [
          organizationId,
          storeId,
          v.name,
          v.channel,
          v.locale,
          v.currency,
          JSON.stringify(v.filters),
          JSON.stringify(v.mapping),
          v.status,
        ],
      )
      .catch((e) => mapPgError(e, `feed "${v.name}"`));
    const feed = toFeed(inserted.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'feed.create',
      entityType: 'product_feed',
      entityId: feed.id,
      after: feed,
    });
    return feed;
  });
}

export async function updateFeed(
  client: ScopedClient,
  storeId: string,
  id: string,
  input: ProductFeedInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ProductFeed> {
  const organizationId = client.context.organizationId;
  const store = await storeFacts(client, storeId);
  const v = normaliseFeedInput(input, store);
  return client.transaction(async (tx) => {
    const before = toFeed(await loadRow(tx, storeId, id));
    const updated = await tx
      .query<ProductFeedRow>(
        `UPDATE product_feed SET name = $3, channel = $4, locale = $5, currency = $6, filters = $7, mapping = $8,
                                 status = $9
          WHERE store_id = $1 AND id = $2
         RETURNING ${COLUMNS}`,
        [
          storeId,
          id,
          v.name,
          v.channel,
          v.locale,
          v.currency,
          JSON.stringify(v.filters),
          JSON.stringify(v.mapping),
          v.status,
        ],
      )
      .catch((e) => mapPgError(e, `feed "${v.name}"`));
    const after = toFeed(updated.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'feed.update',
      entityType: 'product_feed',
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

export async function deleteFeed(
  client: ScopedClient,
  storeId: string,
  id: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<void> {
  const organizationId = client.context.organizationId;
  const store = await storeFacts(client, storeId);
  const row = await loadRow(client, storeId, id);
  await client.transaction(async (tx) => {
    const before = toFeed(row);
    await tx.query(`DELETE FROM product_feed WHERE store_id = $1 AND id = $2`, [storeId, id]);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'feed.delete',
      entityType: 'product_feed',
      entityId: id,
      before,
    });
  });
  // "the published file stops being served" (contract). Best effort and after the commit: a storage hiccup must
  // not resurrect a deleted definition, and a stale artifact serves a feed nobody links to any more.
  await getFeedStorage()
    .remove(feedKey(store.code, id, FEED_EXTENSION[row.channel]))
    .catch(() => undefined);
}

/** The rows the feed emits right now, computed from `filters` + `mapping`, with their per-item errors. */
export async function listFeedItems(
  client: ScopedClient,
  storeId: string,
  id: string,
  query: { page?: number; limit?: number } = {},
): Promise<Page<FeedItem>> {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const row = await loadRow(client, storeId, id);
  const { items } = await buildFeedItems(client, storeId, row);
  validateItems(items, row.channel);
  return {
    page,
    limit,
    total: items.length,
    items: items.slice((page - 1) * limit, (page - 1) * limit + limit),
  };
}

/**
 * Generates the file, stores it and records the result. Returns the feed as it now stands.
 *
 * `status` is `error` when the feed could not produce a usable file — a feed-level problem (no domain to link
 * to) or every row rejected — and `active` otherwise. An empty catalogue is `active` with `item_count: 0`: an
 * empty feed is a true statement about a store with nothing published, not a failure.
 */
export async function publishFeed(
  client: ScopedClient,
  storeId: string,
  id: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ProductFeed> {
  const organizationId = client.context.organizationId;
  const store = await storeFacts(client, storeId);
  const row = await loadRow(client, storeId, id);

  if (!RENDERABLE_CHANNELS.includes(row.channel)) {
    throw conflict(`no renderer for channel ${row.channel} yet`, {
      channel: row.channel,
      renderable: [...RENDERABLE_CHANNELS],
    });
  }

  const { items, errors: buildErrors } = await buildFeedItems(client, storeId, row);
  const itemErrors = validateItems(items, row.channel);
  const publishable = publishableItems(items);
  const errors: FeedError[] = [...buildErrors, ...itemErrors];

  const feedLevelFailure = buildErrors.length > 0;
  const everythingRejected = items.length > 0 && publishable.length === 0;
  const status: FeedStatus = feedLevelFailure || everythingRejected ? 'error' : 'active';

  const storage = getFeedStorage();
  const key = feedKey(store.code, id, FEED_EXTENSION[row.channel]);
  const body = renderFeed(row.channel, publishable, {
    name: row.name,
    link: publishable[0]?.link ? new URL(publishable[0].link).origin : null,
  });
  const hash = sha256(body);
  const stored = await storage.head(key);
  const changed = stored !== hash;

  // The artifact is written before the row so a row claiming a URL always has a file behind it. A failure
  // between the two leaves an orphaned artifact, which the next publish overwrites — the harmless direction.
  const url = changed ? (await storage.put(key, body, row.channel)).url : storage.urlFor(key);
  const now = new Date();

  return client.transaction(async (tx) => {
    const before = toFeed(row);
    const updated = await tx.query<ProductFeedRow>(
      `UPDATE product_feed SET url = $3, status = $4, item_count = $5, errors = $6,
                               last_published_at = CASE WHEN $7 THEN $8 ELSE last_published_at END
        WHERE store_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [storeId, id, url, status, publishable.length, JSON.stringify(errors), changed, now],
    );
    const after = toFeed(updated.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'feed.publish',
      entityType: 'product_feed',
      entityId: id,
      before,
      after,
    });
    // Unchanged bytes are not an event: consumers act on a feed that actually moved.
    if (changed) {
      await withEvents(tx, [
        await buildEvent({
          topic: 'feed.published',
          organizationId,
          storeId,
          aggregateType: 'feed',
          aggregateId: id,
          occurredAt: now,
          ...(actor.id ? { actor: eventActor(actor) } : {}),
          payload: {
            feed_id: id,
            channel: row.channel,
            locale: row.locale,
            currency: row.currency,
            item_count: publishable.length,
            url,
            published_at: now.toISOString(),
          },
        }),
      ]);
    }
    return after;
  });
}
