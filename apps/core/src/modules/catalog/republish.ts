// The catalogue re-publish (#634): a catalogue that predates the bus — the dev stack's seeded products were inserted
// by the db seed and never published — announced as events, so every consumer sees it the way it sees a publish.
// For every PUBLISHED product in scope it writes `product.published` v1 with the product's CURRENT state (the same
// builder `publishProduct` uses) through `withEvents`: the same validation, the same outbox, the relay delivers it.
// It changes no row and writes no audit row: it re-announces existing state.
//
// Idempotent by default: a product that already has a `product.published` row in the outbox (it went through the
// bus) is skipped — checked through the outbox's aggregate index, and again inside every batch's transaction, so a
// product published while the command runs is not announced twice. `force` re-announces every published product (a
// consumer that needs a full refresh — every consumer treats a re-announcement idempotently, see the README).
// `dryRun` counts and writes nothing. A published product without `published_at` cannot be a valid event: it is
// skipped and reported (`missing_published_at`), never an abort. Organization scope (HQ).
import type { Queryable, ScopedClient } from '@platform/db';
import { SYSTEM_ACTOR, type Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { withEvents } from '../../outbox';
import { loadAggregates, productPublishedEvent } from './service';
import type { ProductRow } from './types';

/** Products per transaction: default and the clamp. */
export const REPUBLISH_BATCH = { default: 200, max: 1000 } as const;

export interface RepublishOptions {
  /** Only these stores (default: every store of the organization). */
  storeIds?: readonly string[] | undefined;
  /** Re-announce products that already went through the bus too. */
  force?: boolean | undefined;
  /** Count only; write nothing. */
  dryRun?: boolean | undefined;
  /** Products per transaction (default 200, at most 1000). */
  batch?: number | undefined;
  actor?: Actor | undefined;
}

export interface RepublishStoreResult {
  store_id: string;
  /** Announced (on a dry run: would be announced). */
  published: number;
  /** Published products already on the bus (not re-announced without `force`). */
  skipped: number;
  /** Published products without `published_at`: no valid event can be built, so they are left out. */
  missing_published_at: number;
}

export interface RepublishResult {
  stores: RepublishStoreResult[];
  dry_run: boolean;
}

const PRODUCT_COLS =
  'p.id, p.store_id, p.handle, p.title, p.subtitle, p.description, p.status, p.category_id, p.brand_name, p.tags, p.attributes, p.seo, p.thumbnail_url, p.published_at, p.created_at, p.updated_at';

/** "Not yet on the bus": no `product.published` row for the product (the outbox's aggregate index). */
const NOT_ON_BUS = `NOT EXISTS (
  SELECT 1 FROM outbox o
  WHERE o.aggregate_type = 'product' AND o.aggregate_id = p.id AND o.topic = 'product.published'
)`;

/** The ids of the published products of one store that are to be announced, in a stable order. */
async function candidates(tx: Queryable, storeId: string, force: boolean): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `SELECT p.id FROM product p
     WHERE p.store_id = $1 AND p.status = 'published' AND p.published_at IS NOT NULL
       AND ($2 OR ${NOT_ON_BUS})
     ORDER BY p.handle, p.id`,
    [storeId, force],
  );
  return r.rows.map((x) => x.id);
}

export async function republishCatalogue(
  client: ScopedClient,
  opts: RepublishOptions = {},
): Promise<RepublishResult> {
  if (client.scope !== 'organization') {
    throw new AppError('forbidden', 'the catalogue re-publish requires organization scope');
  }
  const batch = Math.max(1, Math.min(REPUBLISH_BATCH.max, opts.batch ?? REPUBLISH_BATCH.default));
  const force = opts.force === true;
  const dryRun = opts.dryRun === true;
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const organizationId = client.context.organizationId;

  const stores = (
    await client.query<{ id: string }>(
      `SELECT id FROM store WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY code`,
      [opts.storeIds && opts.storeIds.length ? [...opts.storeIds] : null],
    )
  ).rows.map((r) => r.id);

  const result: RepublishResult = { stores: [], dry_run: dryRun };
  for (const storeId of stores) {
    const { ids, published, missing } = await client.transaction(async (tx) => {
      const pending = await candidates(tx, storeId, force);
      const counts = await tx.query<{ all: string; missing: string }>(
        `SELECT count(*)::text AS all, count(*) FILTER (WHERE published_at IS NULL)::text AS missing
         FROM product WHERE store_id = $1 AND status = 'published'`,
        [storeId],
      );
      return {
        ids: pending,
        published: Number(counts.rows[0]?.all ?? 0),
        missing: Number(counts.rows[0]?.missing ?? 0),
      };
    });
    let written = 0;
    if (!dryRun) {
      for (let i = 0; i < ids.length; i += batch) {
        const chunk = ids.slice(i, i + batch);
        // one transaction per batch: a failure writes nothing for that batch (and stops the run), a rerun picks it
        // up; the NOT EXISTS is checked again here so a product published meanwhile is not announced twice
        written += await client.transaction(async (tx) => {
          const rows = await tx.query<ProductRow>(
            `SELECT ${PRODUCT_COLS} FROM product p
             WHERE p.id = ANY($1) AND p.status = 'published' AND p.published_at IS NOT NULL
               AND ($2 OR ${NOT_ON_BUS})
             ORDER BY p.handle, p.id`,
            [chunk, force],
          );
          const aggregates = await loadAggregates(tx, rows.rows);
          await withEvents(
            tx,
            await Promise.all(
              aggregates.map((a) => productPublishedEvent(organizationId, a, actor)),
            ),
          );
          return aggregates.length;
        });
      }
    }
    result.stores.push({
      store_id: storeId,
      published: dryRun ? ids.length : written,
      skipped: published - missing - ids.length,
      missing_published_at: missing,
    });
  }
  return result;
}
