// The registry's `StoreRegistrar` over OpenFGA (#413): the `organization:hq#organization` tuple on `store:<id>`
// that makes a store resolvable by scope resolution at all (`owner from organization`, `analyst from
// organization`, …). INTERIM ADAPTER: window 2 ships `ensureStoreObject(storeId, { fga, organization })` in
// `@platform/auth-sdk` (#415, signature final on the issue); when it is on main this file calls it instead of
// writing the tuple itself — same seam, same semantics (read first, write only when missing, a concurrent
// duplicate write tolerated, OpenFGA unreachable = 503 fail closed).
import type { OpenFgaClient } from '@platform/auth-sdk';
import { AppError } from '../lib/errors';
import type { StoreRegistrar } from '../modules/registry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoreRegistrarOptions {
  /** Organization slug: the FGA object `organization:<slug>`. Default `hq` (the seeded organization). */
  organization?: string;
}

function tupleFor(storeId: string, organization: string) {
  if (!UUID.test(storeId)) {
    throw new AppError('validation_error', 'storeId must be a uuid', { storeId: 'uuid' });
  }
  return {
    user: `organization:${organization}`,
    relation: 'organization',
    object: `store:${storeId}`,
  };
}

/** OpenFGA unreachable or refusing → 503 `internal`, like every other guard (fail closed). */
function unavailable(err: unknown): never {
  throw new AppError(
    'internal',
    'authorization service unavailable',
    { cause: err instanceof Error ? err.message : String(err) },
    503,
  );
}

/** Whether OpenFGA's 400 on a duplicate write is the "already exists" one. */
function isDuplicateWrite(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists|write_failed_due_to_invalid_input|duplicate/i.test(msg);
}

export function openFgaStoreRegistrar(
  fga: OpenFgaClient,
  opts: StoreRegistrarOptions = {},
): StoreRegistrar {
  const organization = opts.organization ?? 'hq';
  const has = async (storeId: string): Promise<boolean> => {
    const tuple = tupleFor(storeId, organization);
    const r = await fga.check(tuple).catch(unavailable);
    return r.allowed === true;
  };
  return {
    hasStoreObject: has,
    async ensureStoreObject(storeId) {
      const tuple = tupleFor(storeId, organization);
      if (await has(storeId)) return;
      try {
        await fga.write({ writes: [tuple] });
      } catch (err) {
        if (isDuplicateWrite(err)) return; // another caller wrote it between our read and our write
        unavailable(err);
      }
    },
  };
}
