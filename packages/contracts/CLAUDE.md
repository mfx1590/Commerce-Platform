# @platform/contracts

## Purpose

The frozen API contract (tag contracts-v0.1): OpenAPI 3.1 for the **Store API** (`openapi/store-api.yaml`, what
storefronts call) and the **Admin API** (`openapi/admin-api.yaml`, what the admin app calls), generated TypeScript
types, shared constants (headers, error codes, relations), and a Prism mock server. Feature windows build against the
mock; the Integrator replaces mocks with the real core.

## Owner

main window only. Feature windows: read-only. Any change goes through an issue titled `CONTRACT CHANGE: <what>`
with the exact YAML diff; the Integrator applies accepted changes, bumps `info.version`, regenerates, and re-tags.

## Run / test

- `pnpm mock` (root) — Store API mock on http://localhost:4010, Admin API mock on http://localhost:4011 (`MOCK_STORE_PORT`, `MOCK_ADMIN_PORT` to override). Send `X-Publishable-Key: anything` / `Authorization: Bearer anything`; the mock only checks presence. Prism validates requests (400 on bad bodies) and responses.
- `pnpm --filter @platform/contracts generate` — regenerates `src/generated/{store,admin}.ts` (openapi-typescript); committed, CI checks they are current.
- `pnpm --filter @platform/contracts test` — static spec checks (every admin operation has `x-permission`, money is integer, nine areas covered).
- `pnpm --filter @platform/contracts test:contract` — boots both mocks on :4110/:4111 and walks the storefront journey + admin surfaces; fails if an example violates its schema.
- `pnpm --filter @platform/contracts build | typecheck`

## Public API

- `import type { StorePaths, StoreComponents, StoreOperations } from '@platform/contracts'` (or `@platform/contracts/store` → `paths`, `components`, `operations`)
- `import type { AdminPaths, AdminComponents, AdminOperations } from '@platform/contracts'` (or `@platform/contracts/admin`)
- `HEADERS` (`X-Publishable-Key`, `Idempotency-Key`, `X-Request-Id`), `MOCK_URLS`, `ERROR_CODES` / `ErrorCode`, `RELATIONS` / `Relation`, `CONTRACTS_VERSION`
- Example: `type Product = StoreComponents['schemas']['Product']`; `type ListOrders = AdminOperations['listOrders']`

## Conventions frozen in the spec

- Store API: every request carries `X-Publishable-Key`; customer routes add a Bearer JWT (Keycloak customers realm). Admin API: Bearer JWT (staff realm).
- Admin store-scoped resources: `/admin/stores/{storeId}/...`; org-level: `/admin/...`. Each operation's `x-permission: { relation, object }` is the OpenFGA check the server performs (`viewer` = any relation on the object).
- Money `{ amount_minor, currency }`; ids uuid; timestamps RFC-3339; lists `{ page, limit, total, items }`; errors `{ code, message, details }`.
- Mutations that create money movements (`completeCart`, `createRefund`) require `Idempotency-Key`.
- Seed ids in examples match `SEED_IDS` in `@platform/db` (brand-a store = `…0031`).

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs.
- Update README.md and CHANGELOG.md with every change.
