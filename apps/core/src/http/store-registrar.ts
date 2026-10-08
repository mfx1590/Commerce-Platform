// The registry's `StoreRegistrar` over OpenFGA (#413): the `organization:hq#organization` tuple on `store:<id>`
// without which no scope resolution ever shows a store (`owner from organization`, `analyst from organization`,
// …). The write is window 2's `ensureStoreObject` (`@platform/auth-sdk`, #415 / #421): read first, write only
// when missing, a concurrent duplicate tolerated, OpenFGA unreachable = 503 fail closed. The existence check
// reads the same tuple (`storeObjectTuple`). auth-sdk's `ApiError`s become the core's `AppError`s here.
import { ensureStoreObject, storeObjectTuple, type OpenFgaClient } from '@platform/auth-sdk';
import { AppError, fromApiError } from '../lib/errors';
import type { StoreRegistrar } from '../modules/registry';

export interface StoreRegistrarOptions {
  /** Organization slug: the FGA object `organization:<slug>`. Default `hq` (the seeded organization). */
  organization?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** OpenFGA unreachable or refusing → 503 `internal`, like every other guard (fail closed). */
function unavailable(err: unknown): never {
  throw new AppError(
    'internal',
    'authorization service unavailable',
    { cause: err instanceof Error ? err.message : String(err) },
    503,
  );
}

export function openFgaStoreRegistrar(
  fga: OpenFgaClient,
  opts: StoreRegistrarOptions = {},
): StoreRegistrar {
  const organization = opts.organization ?? 'hq';
  return {
    async ensureStoreObject(storeId) {
      try {
        await ensureStoreObject(storeId, { fga, organization });
      } catch (err) {
        throw fromApiError(err);
      }
    },
    async hasStoreObject(storeId) {
      if (!UUID.test(storeId)) {
        throw new AppError('validation_error', 'storeId must be a uuid', { storeId: 'uuid' });
      }
      const tuple = storeObjectTuple(storeId, organization);
      const r = await fga
        .read({ user: tuple.user, relation: tuple.relation, object: tuple.object })
        .catch(unavailable);
      return r.tuples.length > 0;
    },
  };
}
