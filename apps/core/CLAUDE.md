# @platform/core

## Purpose

Medusa 2 commerce core (modular monolith). Modules: registry, catalog, pricing, checkout, orders, inventory, fulfillment, customers, hq-rbac, hq-warehouse, payments, tax, fraud, shipping, search, promotions. Phase 0 leaves only this scaffold; window 1 installs Medusa 2 in Phase 1.

## Owner

window 1 (core); sub-folders under src/modules/* belong to windows 2, 7, 8, 9, 11, 13 per docs/ownership.md.

## Run / test

- `pnpm --filter @platform/core build` — compile to dist/
- `pnpm --filter @platform/core typecheck`
- `pnpm --filter @platform/core test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core` before finishing any task.

## Public API

- HTTP: implements `packages/contracts/openapi/store-api.yaml` and `admin-api.yaml` exactly
- Every state change writes to `outbox` in the same transaction (`@platform/events`); the relay in `src/outbox/` publishes
- Module layout: `src/modules/<name>/{index.ts,README.md,tests}`; cross-module imports only via index.ts

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.

## Phase 0 note

This is a scaffold: package.json, tsconfig, an empty index.ts. The owning window replaces it with the real
framework setup (Medusa 2 / Next.js) in its first Phase 1 task. Keep the package name and the CLAUDE.md sections.
