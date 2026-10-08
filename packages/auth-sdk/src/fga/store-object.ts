// Store object registration (issue #415, task 3.1a). A store exists for OpenFGA only once the tuple
// `organization:<slug>#organization@store:<id>` is written: every store relation that derives from the
// organization (`owner from organization`, `analyst from organization`, …) and therefore the scope resolution
// of every HQ user hangs on it. The seed writes it for the three seeded stores; a store created through the
// API gets it from `ensureStoreObject` (window 1's onboarding workflow, #413) and, for anything missed,
// from `fga:reconcile`.
import type { OpenFgaClient, TupleKey } from '@openfga/sdk';
import type { ScopedClient } from '@platform/db';
import { ApiError } from '../types.js';
import { createOpenFgaClient } from './client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnsureStoreObjectOptions {
  /** Bound to the store + model — `createOpenFgaClient()` (env `OPENFGA_*`). Default: one shared env client. */
  fga?: OpenFgaClient;
  /** Organization slug, the FGA object id `organization:<slug>`. Default `hq`. */
  organization?: string;
}

export interface EnsureStoreObjectResult {
  /** `store:<storeId>` */
  object: string;
  /** `organization:<slug>` */
  organization: string;
  /** true when THIS call wrote the tuple; false when it already existed (no write, no error). */
  created: boolean;
}

let defaultFga: OpenFgaClient | undefined;
const fgaOf = (fga?: OpenFgaClient): OpenFgaClient => fga ?? (defaultFga ??= createOpenFgaClient());

/** Test hook: forget the memoized env client (store reseeded). */
export function resetStoreObjectClient(): void {
  defaultFga = undefined;
}

/** The organization tuple of a store. */
export function storeObjectTuple(storeId: string, organization = 'hq'): TupleKey {
  return {
    user: `organization:${organization}`,
    relation: 'organization',
    object: `store:${storeId}`,
  };
}

const unavailable = (err: unknown): ApiError =>
  new ApiError(503, 'internal', 'authorization service unavailable', {
    cause: err instanceof Error ? err.message : String(err),
  });

/** OpenFGA answers 400 `write_failed_due_to_invalid_input` to a tuple that already exists. */
function isDuplicateWrite(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string };
  return e?.statusCode === 400 && /already exists/i.test(e.message ?? '');
}

/**
 * Registers a store with OpenFGA: writes `organization:<slug>#organization@store:<storeId>` unless present.
 * Idempotent and duplicate-tolerant; no DB access, no `role_assignment` mirror (it is not a user role), no
 * audit row (the caller's transaction audits the store itself). Call it AFTER that transaction commits: the
 * tuple is not transactional with Postgres, which is what `fga:reconcile` is for. OpenFGA unreachable → 503.
 */
export async function ensureStoreObject(
  storeId: string,
  opts: EnsureStoreObjectOptions = {},
): Promise<EnsureStoreObjectResult> {
  if (!UUID.test(storeId)) {
    throw new ApiError(400, 'validation_error', 'storeId must be a uuid', { field: 'storeId' });
  }
  const fga = fgaOf(opts.fga);
  const tuple = storeObjectTuple(storeId, opts.organization ?? 'hq');
  const result = { object: tuple.object, organization: tuple.user };
  let existing: number;
  try {
    existing = (
      await fga.read({ user: tuple.user, relation: tuple.relation, object: tuple.object })
    ).tuples.length;
  } catch (err) {
    throw unavailable(err);
  }
  if (existing > 0) return { ...result, created: false };
  try {
    await fga.write({ writes: [tuple] });
  } catch (err) {
    if (isDuplicateWrite(err)) return { ...result, created: false }; // a concurrent caller won the race
    throw unavailable(err);
  }
  return { ...result, created: true };
}

export interface ReconcileStoreObjectsOptions extends EnsureStoreObjectOptions {
  /** Write the missing tuples (`fga:reconcile --fix`). Default: report only. */
  fix?: boolean;
}

export interface ReconcileStoreObjectsReport {
  organization: string;
  /** Every store row seen (id + code), in code order. */
  stores: { id: string; code: string }[];
  /** Stores with no organization tuple BEFORE this run. */
  missing: { id: string; code: string }[];
  /** Stores whose tuple this run wrote (`fix` only). */
  fixed: { id: string; code: string }[];
}

/**
 * Lists the stores of the organization (through the caller's organization-scoped client) that lack the
 * organization tuple in OpenFGA, and writes them when `fix` is set. Each store is checked with one read,
 * the same probe `ensureStoreObject` uses, so a store created before #415 is repaired the same way.
 */
export async function reconcileStoreObjects(
  db: ScopedClient,
  opts: ReconcileStoreObjectsOptions = {},
): Promise<ReconcileStoreObjectsReport> {
  const fga = fgaOf(opts.fga);
  const organization = opts.organization ?? 'hq';
  const rows = await db.query<{ id: string; code: string }>(
    'SELECT id, code FROM store ORDER BY code, id',
  );
  const stores = rows.rows.map((r) => ({ id: r.id, code: r.code }));
  const missing: { id: string; code: string }[] = [];
  for (const s of stores) {
    const t = storeObjectTuple(s.id, organization);
    let n: number;
    try {
      n = (await fga.read({ user: t.user, relation: t.relation, object: t.object })).tuples.length;
    } catch (err) {
      throw unavailable(err);
    }
    if (n === 0) missing.push(s);
  }
  const fixed: { id: string; code: string }[] = [];
  if (opts.fix) {
    for (const s of missing) {
      const r = await ensureStoreObject(s.id, { fga, organization });
      if (r.created) fixed.push(s);
    }
  }
  return { organization: `organization:${organization}`, stores, missing, fixed };
}
