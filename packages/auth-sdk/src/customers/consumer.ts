// The `customer.erased` consumer (issue #483, wiring A): reads the unclaimed events from the outbox, runs
// `deleteErasedCustomerIdentity`, and settles each event with ONE claim row (`customer_erasure_claim`,
// CONTRACT CHANGE #512) after a definitive outcome — so a settled event never calls Keycloak again, however
// often the job polls. A Keycloak outage (503) writes no claim: the event is retried on the next run and counted
// under `retry`, never thrown. The core's job (`apps/core/src/jobs/customer-erasure.ts`, window 13) builds the
// consumer once and calls `runOnce` per tick. Logs nothing; the result carries counts only.
import { createOrganizationClient, createTenantClient } from '@platform/db';
import type { KeycloakAdmin } from '../keycloak/admin.js';
import { isApiError } from '../types.js';
import {
  CUSTOMER_ERASED_VERSIONS,
  deleteErasedCustomerIdentity,
  type CustomerErasureOutcome,
  type CustomerErasureResult,
} from './erasure.js';

/** The application pool, as `@platform/db`'s client factories take it (no direct `pg` dependency here). */
type Pool = Parameters<typeof createOrganizationClient>[0];

export interface CustomerErasureConsumerOptions {
  /** The application pool (`platform_app`); every query goes through a tenant-scoped client. */
  pool: Pool;
  organizationId: string;
  /** Service-account client for the CUSTOMERS realm. */
  keycloak: Pick<KeycloakAdmin, 'deleteUser' | 'realm'>;
  /** Actor recorded on the audit rows; default null = system. */
  actorId?: string | null;
}

export interface CustomerErasureRunResult {
  /** Events settled with a claim in this run. */
  processed: number;
  /** Events left unclaimed because Keycloak was unavailable (retried next run). */
  retry: number;
  /** Events read that were already claimed (none when the query excludes them, kept for the log line). */
  skipped: number;
  outcomes: Record<CustomerErasureOutcome, number>;
}

interface OutboxRow {
  id: string;
  seq: string;
  store_id: string | null;
  payload: { customer_id?: unknown };
}

export interface CustomerErasureConsumer {
  /** One pass: at most `limit` unclaimed `customer.erased` events, oldest first. */
  runOnce(opts?: { limit?: number }): Promise<CustomerErasureRunResult>;
  /** The settled outcome of one event, or null when it is not claimed (tests, operators). */
  claimOf(eventId: string): Promise<{ outcome: CustomerErasureOutcome; live_rows: number } | null>;
}

export function createCustomerErasureConsumer(
  opts: CustomerErasureConsumerOptions,
): CustomerErasureConsumer {
  const org = createOrganizationClient(opts.pool, {
    organizationId: opts.organizationId,
    actorId: opts.actorId ?? null,
  });
  const storeClient = (storeId: string) =>
    createTenantClient(opts.pool, {
      organizationId: opts.organizationId,
      storeIds: [storeId],
      actorId: opts.actorId ?? null,
    });

  async function settle(row: OutboxRow, result: CustomerErasureResult): Promise<void> {
    // The claim belongs to the erased row's store (store RLS); written once, after the audit row of the
    // function itself. ON CONFLICT: a concurrent run settled it first — nothing to add.
    await storeClient(row.store_id!).query(
      `INSERT INTO customer_erasure_claim (organization_id, store_id, event_id, event_seq, customer_id, outcome, live_rows)
       VALUES (app.current_organization_id(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO NOTHING`,
      [row.store_id, row.id, row.seq, result.customerId, result.outcome, result.liveRows],
    );
  }

  return {
    async runOnce(o = {}) {
      const limit = Math.min(1000, Math.max(1, Math.floor(o.limit ?? 100)));
      const result: CustomerErasureRunResult = {
        processed: 0,
        retry: 0,
        skipped: 0,
        outcomes: { nothing_to_delete: 0, kept_live_elsewhere: 0, deleted: 0, already_gone: 0 },
      };
      // Unclaimed customer.erased events of the organization, oldest first. The organization-scope client sees
      // every store's outbox rows and claims.
      const rows = await org.query<OutboxRow>(
        `SELECT o.id, o.seq::text AS seq, o.store_id, o.payload
           FROM outbox o
           LEFT JOIN customer_erasure_claim c ON c.event_id = o.id
          WHERE o.topic = 'customer.erased' AND o.version = ANY($2::int[]) AND c.event_id IS NULL
          ORDER BY o.seq
          LIMIT $1`,
        [limit, [...CUSTOMER_ERASED_VERSIONS]],
      );
      for (const row of rows.rows) {
        const customerId =
          typeof row.payload?.customer_id === 'string' ? row.payload.customer_id : '';
        if (!row.store_id || !customerId) {
          // Malformed for this consumer (no store, no customer id): settle as nothing_to_delete so it is not
          // re-read forever; the audit row of the function is not written for it.
          const r: CustomerErasureResult = {
            customerId: customerId || row.id,
            outcome: 'nothing_to_delete',
            liveRows: 0,
          };
          if (row.store_id) await settle(row, r);
          result.processed++;
          result.outcomes.nothing_to_delete++;
          continue;
        }
        let r: CustomerErasureResult;
        try {
          r = await deleteErasedCustomerIdentity(
            { db: org, keycloak: opts.keycloak },
            { customerId },
          );
        } catch (err) {
          if (isApiError(err) && err.status === 503) {
            result.retry++; // Keycloak unavailable: no claim, next run retries
            continue;
          }
          throw err;
        }
        await settle(row, r);
        result.processed++;
        result.outcomes[r.outcome]++;
      }
      return result;
    },
    async claimOf(eventId) {
      const r = await org.query<{ outcome: CustomerErasureOutcome; live_rows: number }>(
        'SELECT outcome, live_rows FROM customer_erasure_claim WHERE event_id = $1',
        [eventId],
      );
      return r.rows[0] ?? null;
    },
  };
}
