// The in-memory `StoreRegistrar` (#413): for unit tests and for dev runs that have no OpenFGA. It remembers
// what was registered and never talks to a server. The real one — OpenFGA, interim adapter until window 2's
// `ensureStoreObject` (#415) — lives in src/http/store-registrar.ts, because the registry itself never talks
// to OpenFGA; the routes hand the implementation in.
import type { StoreRegistrar } from './types';

export interface InMemoryStoreRegistrar extends StoreRegistrar {
  /** Store ids registered so far (seed it to simulate an already-registered store). */
  readonly registered: Set<string>;
  /** How many times `ensureStoreObject` was called (the repeat path calls it again on purpose). */
  readonly ensureCalls: string[];
}

export function inMemoryStoreRegistrar(initial: string[] = []): InMemoryStoreRegistrar {
  const registered = new Set(initial);
  const ensureCalls: string[] = [];
  return {
    registered,
    ensureCalls,
    ensureStoreObject: async (storeId) => {
      ensureCalls.push(storeId);
      registered.add(storeId);
    },
    hasStoreObject: async (storeId) => registered.has(storeId),
  };
}
