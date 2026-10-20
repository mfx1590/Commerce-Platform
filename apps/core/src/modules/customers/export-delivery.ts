// Export delivery (#472, CONTRACT CHANGE #498): the consumer of `customer.export_requested` and the home of the
// `customer_export` rows (db 0195). Three phases per store, run by `src/jobs/customer-export.ts` (every five
// minutes, or as a one-shot CLI), on the notifications app's CLAIM / DELIVER split:
//
// - CLAIM (one transaction, no I/O): every `customer.export_requested` outbox row of the store that has no
//   `customer_export` row for its `event_id` becomes one `pending` row (`UNIQUE (event_id)` + ON CONFLICT DO
//   NOTHING — idempotent on the event id: a replayed event or a re-run never builds twice; no cursor table).
// - BUILD (one transaction per row): `buildCustomerExport` on the store-scoped client → JSON → gzip → under the
//   HARD SIZE CAP (`maxBytes`, default 8 MiB compressed; manager decision 2026-10-18: one customer cannot fill
//   the database) → `ready` with the bundle, its sha256 and size, `expires_at = ready_at + ttlDays` (30), and ONE
//   `customer.export_ready` in the same transaction. A customer gone (unknown or erased) by then → `expired` /
//   `customer_gone`; a bundle above the cap → `expired` / `too_large`; neither emits an event.
// - PURGE: `ready` rows past `expires_at` → bundle NULL, `expired`, `purged_at`. The bare row (ids, timestamps,
//   status — no personal data) stays as the record that the request was served; a later download is 410.
//
// Downloads (`getMyExport`, admin `getCustomerExport`) verify the sha256, decompress, count and audit — ids only.
// Erasure deletes every export of the customer, bundles included (gdpr.ts). Nothing here logs a bundle.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Queryable, ScopedClient } from '@platform/db';
import type { StoreComponents } from '@platform/contracts';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { buildEvent, withEvents } from '../../outbox';
import { buildCustomerExport } from './gdpr';
import { resolveIn } from './service';
import type { CustomerIdentity, CustomerScope } from './types';

export const EXPORT_FORMAT = 'customer-export/v1';
export const DEFAULT_EXPORT_TTL_DAYS = 30;
/** Compressed bytes. */
export const DEFAULT_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
export const EXPORT_CLAIM_LOOKBACK = 500;

/** Store API `CustomerExportSummary`. */
export type CustomerExportSummary = StoreComponents['schemas']['CustomerExportSummary'];
/** Admin API item: the summary plus who asked and how often it was downloaded. */
export interface AdminCustomerExportSummary extends CustomerExportSummary {
  requested_by: string;
  requested_by_type: 'staff' | 'customer';
  download_count: number;
}

const notFound = (id: string) => new AppError('not_found', 'export not found', { export_id: id });
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

interface SummaryRow {
  id: string;
  status: 'pending' | 'ready' | 'expired';
  requested_at: Date;
  ready_at: Date | null;
  expires_at: Date | null;
  bundle_size: number | null;
  reason: 'customer_gone' | 'too_large' | null;
  requested_by: string;
  requested_by_type: 'staff' | 'customer';
  download_count: number;
}
const SUMMARY_COLS = `id, status, requested_at, ready_at, expires_at, bundle_size, reason, requested_by,
  requested_by_type, download_count`;

const toSummary = (r: SummaryRow): CustomerExportSummary => ({
  id: r.id,
  status: r.status,
  requested_at: r.requested_at.toISOString(),
  ready_at: iso(r.ready_at),
  expires_at: iso(r.expires_at),
  size_bytes: r.bundle_size,
  reason: r.reason,
});
const toAdminSummary = (r: SummaryRow): AdminCustomerExportSummary => ({
  ...toSummary(r),
  requested_by: r.requested_by,
  requested_by_type: r.requested_by_type,
  download_count: r.download_count,
});

// --------------------------------------------------------------------------------------------- the job's phases

interface RequestedPayload {
  customer_id: string;
  requested_by: string;
  requested_by_type?: 'staff' | 'customer';
  requested_at: string;
}

/** CLAIM: one `pending` row per unclaimed `customer.export_requested` event of the store (newest `lookback`). */
export async function claimExportRequests(
  client: ScopedClient,
  storeId: string,
  options: { lookback?: number } = {},
): Promise<{ scanned: number; claimed: number }> {
  const lookback = Math.max(1, options.lookback ?? EXPORT_CLAIM_LOOKBACK);
  const organizationId = client.context.organizationId;
  return client.transaction(async (tx) => {
    const rows = await tx.query<{ id: string; version: number; payload: RequestedPayload }>(
      `SELECT o.id, o.version, o.payload FROM outbox o
        WHERE o.store_id = $1 AND o.topic = 'customer.export_requested'
          AND NOT EXISTS (SELECT 1 FROM customer_export x WHERE x.event_id = o.id)
        ORDER BY o.seq DESC LIMIT $2`,
      [storeId, lookback],
    );
    let claimed = 0;
    for (const row of rows.rows) {
      const p = row.payload;
      // v1 (events 0.3.2) carried a staff id only; v2 says who asked.
      const requestedByType = p.requested_by_type ?? 'staff';
      const ins = await tx.query(
        `INSERT INTO customer_export (organization_id, store_id, customer_id, event_id, requested_by,
           requested_by_type, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO NOTHING`,
        [
          organizationId,
          storeId,
          p.customer_id,
          row.id,
          p.requested_by,
          requestedByType,
          p.requested_at,
        ],
      );
      claimed += ins.rowCount ?? 0;
    }
    return { scanned: rows.rows.length, claimed };
  });
}

export interface BuildOptions {
  now?: Date | undefined;
  ttlDays?: number | undefined;
  maxBytes?: number | undefined;
  limit?: number | undefined;
}

export interface BuildResult {
  built: string[];
  /** Rows that became `expired` without a bundle, by id, with the reason. Ids only. */
  expired: Array<{ id: string; reason: 'customer_gone' | 'too_large' }>;
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/**
 * BUILD: every `pending` row of the store (oldest first, up to `limit`). The bundle is built outside the row's
 * transaction (reads only); the transaction then locks the row, re-checks it is still `pending` (an erasure in
 * between deletes it — then nothing is written and no event is emitted) and makes it `ready` with the event, or
 * `expired` with the reason.
 */
export async function buildPendingExports(
  client: ScopedClient,
  storeId: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const now = options.now ?? new Date();
  const ttlDays = options.ttlDays ?? DEFAULT_EXPORT_TTL_DAYS;
  const maxBytes = options.maxBytes ?? DEFAULT_EXPORT_MAX_BYTES;
  const limit = Math.max(1, options.limit ?? 50);
  const organizationId = client.context.organizationId;
  const result: BuildResult = { built: [], expired: [] };

  const pending = await client.query<{
    id: string;
    customer_id: string;
    requested_by: string;
    requested_by_type: 'staff' | 'customer';
  }>(
    `SELECT id, customer_id, requested_by, requested_by_type FROM customer_export
      WHERE store_id = $1 AND status = 'pending' ORDER BY created_at, id LIMIT $2`,
    [storeId, limit],
  );

  for (const row of pending.rows) {
    let compressed: Buffer | null = null;
    let reason: 'customer_gone' | 'too_large' | null = null;
    try {
      const bundle = await buildCustomerExport(client, storeId, row.customer_id);
      compressed = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
      if (compressed.length > maxBytes) {
        compressed = null;
        reason = 'too_large';
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found') reason = 'customer_gone';
      else throw err;
    }

    await client.transaction(async (tx) => {
      const locked = await tx.query<{ id: string }>(
        `SELECT id FROM customer_export WHERE id = $1 AND status = 'pending' FOR UPDATE`,
        [row.id],
      );
      if (!locked.rows[0]) return; // erased (deleted) or built by another run meanwhile
      if (reason !== null || compressed === null) {
        await tx.query(
          `UPDATE customer_export SET status = 'expired', reason = $2, expires_at = $3 WHERE id = $1`,
          [row.id, reason ?? 'too_large', now],
        );
        result.expired.push({ id: row.id, reason: reason ?? 'too_large' });
        return;
      }
      const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);
      await tx.query(
        `UPDATE customer_export
         SET status = 'ready', format = $2, bundle = $3, bundle_sha256 = $4, bundle_size = $5,
             ready_at = $6, expires_at = $7
         WHERE id = $1`,
        [row.id, EXPORT_FORMAT, compressed, sha256(compressed), compressed.length, now, expiresAt],
      );
      await withEvents(tx, [
        await buildEvent({
          topic: 'customer.export_ready',
          organizationId,
          storeId,
          aggregateType: 'customer',
          aggregateId: row.customer_id,
          actor: { type: 'system', id: null },
          payload: {
            export_id: row.id,
            customer_id: row.customer_id,
            requested_by: row.requested_by,
            requested_by_type: row.requested_by_type,
            expires_at: expiresAt.toISOString(),
          },
        }),
      ]);
      result.built.push(row.id);
    });
  }
  return result;
}

/** PURGE: `ready` rows past `expires_at` lose their bundle; the bare row stays, `expired`. */
export async function purgeExpiredExports(
  client: ScopedClient,
  storeId: string,
  now: Date = new Date(),
): Promise<number> {
  const r = await client.query(
    `UPDATE customer_export SET bundle = NULL, bundle_size = NULL, bundle_sha256 = NULL, status = 'expired', purged_at = $2
      WHERE store_id = $1 AND status = 'ready' AND expires_at <= $2`,
    [storeId, now],
  );
  return r.rowCount ?? 0;
}

// --------------------------------------------------------------------------------------------- downloads

export interface ExportDownload {
  id: string;
  filename: string;
  /** The decompressed JSON document, verified against the stored sha256. */
  body: Buffer;
}

interface BundleRow {
  id: string;
  status: 'pending' | 'ready' | 'expired';
  bundle: Buffer | null;
  bundle_sha256: string | null;
  expires_at: Date | null;
}

/** The ready bundle of a row, or the contract's 404 (pending) / 410 (expired, purged). */
function openBundle(row: BundleRow): Buffer {
  if (row.status === 'pending') throw notFound(row.id);
  if (row.status === 'expired' || row.bundle === null) {
    throw new AppError('expired', 'This export has expired', {
      export_id: row.id,
      expires_at: iso(row.expires_at),
    });
  }
  if (sha256(row.bundle) !== row.bundle_sha256) {
    // A bundle that does not match its own digest is never served. Ids only in the error.
    throw new AppError('internal', 'export bundle failed verification', { export_id: row.id });
  }
  return gunzipSync(row.bundle);
}

async function download(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  row: BundleRow,
  actor: Actor,
): Promise<ExportDownload> {
  const body = openBundle(row);
  await tx.query(`UPDATE customer_export SET download_count = download_count + 1 WHERE id = $1`, [
    row.id,
  ]);
  await writeAudit(tx, {
    organizationId,
    storeId,
    actor,
    action: 'customer_export.download',
    entityType: 'customer_export',
    entityId: row.id,
    after: { bytes: body.length },
  });
  return { id: row.id, filename: `customer-export-${row.id}.json`, body };
}

const BUNDLE_COLS = 'id, status, bundle, bundle_sha256, expires_at';

/** `GET /store/customers/me/exports`: the customer's own requests, newest first. */
export async function listMyExports(
  client: ScopedClient,
  scope: CustomerScope,
  identity: CustomerIdentity,
): Promise<CustomerExportSummary[]> {
  return client.transaction(async (tx) => {
    const { row } = await resolveIn(tx, scope, identity);
    const r = await tx.query<SummaryRow>(
      `SELECT ${SUMMARY_COLS} FROM customer_export WHERE customer_id = $1 ORDER BY created_at DESC, id DESC`,
      [row.id],
    );
    return r.rows.map(toSummary);
  });
}

/** `GET /store/customers/me/exports/{exportId}`: the customer's own ready bundle (404 / 410 otherwise). */
export async function getMyExport(
  client: ScopedClient,
  scope: CustomerScope,
  identity: CustomerIdentity,
  exportId: string,
): Promise<ExportDownload> {
  return client.transaction(async (tx) => {
    const { row } = await resolveIn(tx, scope, identity);
    const r = await tx.query<BundleRow>(
      `SELECT ${BUNDLE_COLS} FROM customer_export WHERE id = $1 AND customer_id = $2 FOR UPDATE`,
      [exportId, row.id],
    );
    if (!r.rows[0]) throw notFound(exportId);
    const actor: Actor = { id: row.id, type: 'customer', requestId: scope.requestId ?? null };
    return download(tx, scope.organizationId, scope.storeId, r.rows[0], actor);
  });
}

async function requireLiveCustomer(
  q: Queryable,
  storeId: string,
  customerId: string,
): Promise<void> {
  const r = await q.query<{ status: string }>(
    'SELECT status FROM customer WHERE id = $1 AND store_id = $2',
    [customerId, storeId],
  );
  if (!r.rows[0] || r.rows[0].status === 'erased') {
    throw new AppError('not_found', 'customer not found', { customer_id: customerId });
  }
}

/** Admin `listCustomerExports` (store_admin): 404 for unknown, another store's and erased customers. */
export async function adminListCustomerExports(
  client: ScopedClient,
  storeId: string,
  customerId: string,
): Promise<AdminCustomerExportSummary[]> {
  await requireLiveCustomer(client, storeId, customerId);
  const r = await client.query<SummaryRow>(
    `SELECT ${SUMMARY_COLS} FROM customer_export WHERE customer_id = $1 AND store_id = $2
      ORDER BY created_at DESC, id DESC`,
    [customerId, storeId],
  );
  return r.rows.map(toAdminSummary);
}

/** Admin `getCustomerExport` (store_admin): the bundle, audited with the staff actor. */
export async function adminGetCustomerExport(
  client: ScopedClient,
  storeId: string,
  customerId: string,
  exportId: string,
  actor: Actor,
): Promise<ExportDownload> {
  const organizationId = client.context.organizationId;
  return client.transaction(async (tx) => {
    await requireLiveCustomer(tx, storeId, customerId);
    const r = await tx.query<BundleRow>(
      `SELECT ${BUNDLE_COLS} FROM customer_export WHERE id = $1 AND customer_id = $2 AND store_id = $3 FOR UPDATE`,
      [exportId, customerId, storeId],
    );
    if (!r.rows[0]) throw notFound(exportId);
    return download(tx, organizationId, storeId, r.rows[0], actor);
  });
}
