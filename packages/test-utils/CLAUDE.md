# @platform/test-utils

## Purpose

Shared test fixtures and factories: brand/store/product/order factories with deterministic IDs, a Postgres test-database helper (creates a throwaway database per test file), and an events assertion helper.

## Owner

main window.

## Run / test

- `pnpm --filter @platform/test-utils build` — compile to dist/
- `pnpm --filter @platform/test-utils typecheck`
- `pnpm --filter @platform/test-utils test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/test-utils` before finishing any task.

## Public API

- `makeStore(overrides)`, `makeProduct(storeId, overrides)`, `makeOrder(storeId, overrides)` — factories with deterministic ids
- `withTestDb(fn)` — migrates a fresh database, runs `fn(pool)`, drops it
- `SEED_IDS` — the fixed UUIDs used by `pnpm db:seed` (brand-a/b/c, wh-eu/wh-us, one user per role)

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.
