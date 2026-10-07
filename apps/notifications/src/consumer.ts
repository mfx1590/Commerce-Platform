// The outbox consumer (#360): claim events exactly once, then deliver what was claimed.
//
// Two phases on purpose. CLAIM is one transaction per store — read the cursor, read the outbox after it, write
// one `notification_delivery` row per event (`UNIQUE (event_id)`, ON CONFLICT DO NOTHING), advance the cursor —
// and touches no network. DELIVER runs after that commit, row by row: load the order from the database, render,
// stamp the attempt, send, mark the outcome. A send is never inside a transaction, so a slow provider holds no
// lock and a crash leaves a row that says exactly how far it got.
//
// "Exactly once" here means: never twice, and never silently zero. A re-delivered event or a reset cursor hits
// the unique constraint and produces nothing; a provider refusal is retried a bounded number of times; a crash
// between the send and the mark leaves a `pending` row with `attempted_at` set — "stuck" — which is reported
// and NOT resent, because the email may already have arrived. The owner decides about those.
import type { Queryable, ScopedClient } from '@platform/db';
import { applyLegalEntity } from './brands.js';
import { loadOrderConfirmation, loadShipmentShipped } from './render-data.js';
import { pickLocale, render } from './templates/index.js';
import {
  CONSUMED_TOPICS,
  TOPIC_KINDS,
  TransportError,
  type BrandProfile,
  type ConsumedTopic,
  type DeliveryMeta,
  type Logger,
  type NotificationKind,
  type RenderedEmail,
  type Transport,
} from './types.js';

/** `marketing_cursor.name` of this consumer (one position per store). */
export const CURSOR_NAME = 'notifications';

export interface StoreTarget {
  id: string;
  code: string;
  defaultLocale: string;
  timeZone: string;
  legal: { name: string; vatNumber: string | null };
}

export interface ConsumerOptions {
  /** Outbox rows claimed per run and store (default 100). `scanned === batchSize` means more may be waiting. */
  batchSize?: number;
  /** Provider refusals are retried on later runs until this many attempts (default 5). */
  maxAttempts?: number;
  /**
   * How far behind the cursor every run re-reads (default 500 rows). `seq` is assigned when the producer's
   * transaction inserts, not when it commits, so a row with a lower `seq` can become visible after a higher
   * one was read and advanced the cursor past it. Re-reading a window below the cursor catches such a row on
   * the next run; `UNIQUE (event_id)` makes re-reading the already-claimed ones free. Clock-free on purpose:
   * comparing a Node-written `occurred_at` with the database's `now()` fails on ordinary skew (Memory-17).
   */
  lookback?: number;
}

export interface ConsumerDeps extends ConsumerOptions {
  client: ScopedClient;
  transport: Transport;
  /** The brand profile for a store code, before the legal entity is applied. */
  brands: (storeCode: string) => BrandProfile | null;
  log: Logger;
}

export interface ClaimResult {
  /** Outbox rows read this run, including the lookback window below the cursor. */
  scanned: number;
  /** Rows that became a new delivery (first time seen). */
  claimed: number;
  cursor: number;
}

export interface DeliverResult {
  sent: number;
  failed: number;
  skipped: number;
  /** Rows left by a crash between send and mark; reported, never retried. */
  stuck: number;
  /** Failed rows that reached the attempt limit. */
  exhausted: number;
}

export interface StoreRunReport extends ClaimResult, DeliverResult {
  storeCode: string;
}

export interface RunReport {
  ranAt: string;
  stores: StoreRunReport[];
}

/** The stores a worker serves, from their codes. Throws when a code is unknown — a typo must not be silence. */
export async function resolveStores(
  db: Queryable,
  codes: readonly string[],
): Promise<StoreTarget[]> {
  const res = await db.query<{
    id: string;
    code: string;
    default_locale: string;
    timezone: string;
    legal_name: string;
    vat_number: string | null;
  }>(
    `SELECT s.id, s.code, s.default_locale, s.timezone, le.name AS legal_name, le.vat_number
       FROM store s JOIN legal_entity le ON le.id = s.legal_entity_id
      WHERE s.code = ANY($1)`,
    [[...codes]],
  );
  const byCode = new Map(res.rows.map((r) => [r.code, r]));
  return codes.map((code) => {
    const r = byCode.get(code);
    if (!r) throw new Error(`notifications: unknown store code "${code}"`);
    return {
      id: r.id,
      code: r.code,
      defaultLocale: r.default_locale,
      timeZone: r.timezone,
      legal: { name: r.legal_name, vatNumber: r.vat_number },
    };
  });
}

async function readCursor(tx: Queryable, storeId: string): Promise<number> {
  const res = await tx.query<{ seq: string }>(
    `SELECT seq::text AS seq FROM marketing_cursor WHERE store_id = $1 AND name = $2`,
    [storeId, CURSOR_NAME],
  );
  return Number(res.rows[0]?.seq ?? 0);
}

async function writeCursor(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  seq: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO marketing_cursor (organization_id, store_id, name, seq)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_id, name) DO UPDATE SET seq = GREATEST(marketing_cursor.seq, EXCLUDED.seq)`,
    [organizationId, storeId, CURSOR_NAME, seq],
  );
}

interface OutboxRow {
  id: string;
  seq: string;
  topic: ConsumedTopic;
  aggregate_id: string;
}

/** CLAIM: one transaction, no network. */
export async function claimEvents(
  client: ScopedClient,
  store: StoreTarget,
  options: ConsumerOptions = {},
): Promise<ClaimResult> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const lookback = Math.max(0, options.lookback ?? 500);
  const organizationId = client.context.organizationId;

  return client.transaction(async (tx) => {
    const cursor = await readCursor(tx, store.id);
    const rows = await tx.query<OutboxRow>(
      `SELECT id, seq::text AS seq, topic, aggregate_id FROM outbox
        WHERE store_id = $1 AND topic = ANY($2) AND seq > GREATEST($3::bigint - $4::bigint, 0)
        ORDER BY seq LIMIT $5`,
      [store.id, CONSUMED_TOPICS, cursor, lookback, batchSize],
    );
    if (rows.rows.length === 0) return { scanned: 0, claimed: 0, cursor };

    let claimed = 0;
    for (const row of rows.rows) {
      const kind = TOPIC_KINDS[row.topic];
      const ins = await tx.query(
        `INSERT INTO notification_delivery (organization_id, store_id, event_id, event_seq, topic, aggregate_id, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (event_id) DO NOTHING`,
        [organizationId, store.id, row.id, row.seq, row.topic, row.aggregate_id, kind],
      );
      claimed += ins.rowCount ?? 0;
    }
    const last = Math.max(cursor, Number(rows.rows[rows.rows.length - 1]!.seq));
    await writeCursor(tx, organizationId, store.id, last);
    return { scanned: rows.rows.length, claimed, cursor: last };
  });
}

interface DeliveryRow {
  id: string;
  event_id: string;
  kind: NotificationKind;
  aggregate_id: string;
  attempts: number;
}

/**
 * A short, address-free label for a log line or `last_error`. A `TransportError` is built to be a label (status
 * + provider error name); any other error contributes its NAME only — a database or filesystem message is not
 * guaranteed to be free of the recipient, so it never reaches a row or a log line (#396 review).
 */
export function errorLabel(err: unknown): string {
  if (err instanceof TransportError) return err.message;
  if (err instanceof Error) return err.name;
  return 'error';
}

function describe(meta: DeliveryMeta): string {
  return `kind=${meta.kind} store=${meta.storeCode} locale=${meta.locale} event=${meta.eventId} order=#${meta.displayId}`;
}

/** DELIVER: every claimed row of the store that still needs a send, one by one, outside any transaction. */
export async function deliverPending(
  deps: ConsumerDeps,
  store: StoreTarget,
): Promise<DeliverResult> {
  const { client, transport, log } = deps;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 5);
  const batchSize = Math.max(1, deps.batchSize ?? 100);
  const profile = deps.brands(store.code);
  if (!profile) throw new Error(`notifications: no brand profile for store "${store.code}"`);
  const brand = applyLegalEntity(profile, store.legal);

  const counts = await client.query<{ stuck: number; exhausted: number }>(
    `SELECT count(*) FILTER (WHERE status = 'pending' AND attempted_at IS NOT NULL)::int AS stuck,
            count(*) FILTER (WHERE status = 'failed' AND attempts >= $2)::int AS exhausted
       FROM notification_delivery WHERE store_id = $1`,
    [store.id, maxAttempts],
  );
  const result: DeliverResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    stuck: counts.rows[0]?.stuck ?? 0,
    exhausted: counts.rows[0]?.exhausted ?? 0,
  };
  if (result.stuck > 0) {
    log.warn(
      `notifications: store=${store.code} stuck=${result.stuck} (attempted, no outcome recorded — not resent; see README)`,
    );
  }

  const rows = await client.query<DeliveryRow>(
    `SELECT id, event_id, kind, aggregate_id, attempts FROM notification_delivery
      WHERE store_id = $1
        AND ((status = 'pending' AND attempted_at IS NULL) OR (status = 'failed' AND attempts < $2))
      ORDER BY event_seq LIMIT $3`,
    [store.id, maxAttempts, batchSize],
  );

  for (const row of rows.rows) {
    const loaded =
      row.kind === 'order_confirmation'
        ? await loadOrderConfirmation(client, store.id, row.aggregate_id)
        : await loadShipmentShipped(client, store.id, row.aggregate_id);
    if (!loaded) {
      await client.query(
        `UPDATE notification_delivery SET status = 'skipped', last_error = 'source_not_found' WHERE id = $1`,
        [row.id],
      );
      log.warn(
        `notifications: skipped kind=${row.kind} store=${store.code} event=${row.event_id} (source row not found)`,
      );
      result.skipped += 1;
      continue;
    }

    const locale = pickLocale(loaded.locale, brand.defaultLocale);
    const meta: DeliveryMeta = {
      eventId: row.event_id,
      kind: row.kind,
      storeCode: store.code,
      locale,
      displayId: loaded.data.displayId,
    };
    const content = render(row.kind, loaded.data, { brand, locale, timeZone: store.timeZone });
    const email: RenderedEmail = {
      ...content,
      from: brand.sender,
      to: loaded.to,
      replyTo: brand.replyTo,
    };

    // The stamp is the crash marker: from here until the outcome is written, this row is "in flight".
    const stamped = await client.query<{ attempts: number }>(
      `UPDATE notification_delivery
          SET status = 'pending', attempts = attempts + 1, attempted_at = now(), locale = $2
        WHERE id = $1 AND (status = 'pending' AND attempted_at IS NULL OR status = 'failed')
        RETURNING attempts`,
      [row.id, locale],
    );
    const attempt = stamped.rows[0]?.attempts;
    if (attempt === undefined) continue; // another worker got there first

    try {
      const sent = await transport.send(email, meta);
      await client.query(
        `UPDATE notification_delivery
            SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, last_error = NULL
          WHERE id = $1`,
        [row.id, transport.name, sent.providerMessageId],
      );
      log.info(
        `notifications: sent ${describe(meta)} provider=${transport.name} attempt=${attempt}`,
      );
      result.sent += 1;
    } catch (err) {
      const label = errorLabel(err).slice(0, 200);
      await client.query(
        `UPDATE notification_delivery SET status = 'failed', last_error = $2 WHERE id = $1`,
        [row.id, label],
      );
      log.warn(`notifications: failed ${describe(meta)} attempt=${attempt} error=${label}`);
      result.failed += 1;
      if (attempt >= maxAttempts) result.exhausted += 1;
    }
  }
  return result;
}

/** One pass over every store: claim, then deliver. */
export async function runOnce(
  deps: ConsumerDeps,
  stores: readonly StoreTarget[],
): Promise<RunReport> {
  const report: RunReport = { ranAt: new Date().toISOString(), stores: [] };
  for (const store of stores) {
    const claim = await claimEvents(deps.client, store, deps);
    const deliver = await deliverPending(deps, store);
    report.stores.push({ storeCode: store.code, ...claim, ...deliver });
  }
  return report;
}
