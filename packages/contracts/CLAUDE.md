# @platform/contracts

## Purpose

Frozen API contracts: OpenAPI 3.1 for the Store API (storefronts) and the Admin API (admin app), generated TypeScript types, and a Prism mock server (`pnpm mock`). Feature windows build against the mock; the Integrator replaces mocks with real wiring.

## Owner

main window only. Feature windows: read-only. Changes go through a CONTRACT CHANGE issue.

## Run / test

- `pnpm --filter @platform/contracts build` — compile to dist/
- `pnpm --filter @platform/contracts typecheck`
- `pnpm --filter @platform/contracts test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/contracts` before finishing any task.

## Public API

- `openapi/store-api.yaml`, `openapi/admin-api.yaml` — the contracts (tagged contracts-vX.Y)
- `import type { paths as StorePaths, components as StoreComponents } from '@platform/contracts/store'`
- `import type { paths as AdminPaths, components as AdminComponents } from '@platform/contracts/admin'`
- `pnpm --filter @platform/contracts generate` regenerates types; `pnpm mock` serves both specs on :4010 (store) and :4011 (admin)

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.
