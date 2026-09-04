// Public API of @platform/contracts. Types live in './store' and './admin' (generated from openapi/*.yaml).
export const CONTRACTS_VERSION = '0.1.0' as const;

/** Header names every client and the core agree on. */
export const HEADERS = {
  publishableKey: 'X-Publishable-Key',
  idempotencyKey: 'Idempotency-Key',
  requestId: 'X-Request-Id',
} as const;

/** Local mock servers started by `pnpm mock` (scripts/mock.mjs). */
export const MOCK_URLS = {
  store: 'http://localhost:4010',
  admin: 'http://localhost:4011',
} as const;

/** Stable machine-readable error codes shared by both APIs (`Error.code`). */
export const ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'out_of_stock',
  'payment_failed',
  'cart_completed',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** OpenFGA relations referenced by `x-permission` in admin-api.yaml (ADR 0002). */
export const RELATIONS = ['owner', 'finance', 'operations', 'store_admin', 'store_staff', 'support', 'analyst'] as const;
export type Relation = (typeof RELATIONS)[number];

export type { paths as StorePaths, components as StoreComponents, operations as StoreOperations } from './store.js';
export type { paths as AdminPaths, components as AdminComponents, operations as AdminOperations } from './admin.js';
