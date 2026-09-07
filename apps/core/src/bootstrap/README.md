# bootstrap — readiness verifier

Owner: window 1 (core). Issue #8, re-scoped by the owner on 2026-09-05: **verifier only, no Medusa-side rows**.
The seed data itself is `pnpm db:seed` in `packages/db` (frozen, deterministic); this module never generates or
mirrors anything — it proves the core can serve what the seed (or a real onboarding) put in the database.

## What it checks (read-only, as `platform_app` under `CORE_ORGANIZATION_ID`)

| #   | Check                                                       | Error when                                                                                                                                                                                                             | Fix printed                                      |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | `schema`                                                    | one of `organization`, `legal_entity`, `store`, `sales_channel`, `store_api_key`, `price_list`, `product`, `audit_log`, `outbox` is missing from `public`                                                              | `pnpm db:migrate` / `pnpm dev`                   |
| 2   | `organization`                                              | `CORE_ORGANIZATION_ID` has no row                                                                                                                                                                                      | `pnpm db:seed` or set `CORE_ORGANIZATION_ID`     |
| 3   | `stores` / `sales_channel` / `store_api_key` / `price_list` | no store; a non-archived store without an active sales channel, without a non-revoked publishable key (error), or without an active default price list for its default currency (warning: Store API lists no products) | the Admin API route to create it                 |
| 4   | `seed_keys` (only when the organization is the seeded HQ)   | a seeded publishable key does not resolve through `resolveStoreContext` to its store with the expected default currency (EUR / GBP / USD)                                                                              | `pnpm db:seed` (idempotent)                      |
| 5   | `medusa_schema` / `medusa_links`                            | Medusa's schema (`MEDUSA_DB_SCHEMA`, default `medusa`) is empty, or its link tables were never synced                                                                                                                  | `pnpm --filter @platform/core db:medusa:migrate` |

`ok` is false when any finding has severity `error`.

## How to run

- `pnpm --filter @platform/core bootstrap` — prints the report, exit 0 when ready, exit 1 otherwise.
- At server start (`src/server.ts`) the same checks run once after `initDb()`: findings are logged; the boot
  aborts only when `CORE_BOOTSTRAP_STRICT=1` (recommended for staging/production so a mis-pointed database
  fails fast instead of serving 401s).

## Public API

`verifyBootstrap(): Promise<VerifyResult>` (`{ ok, organizationId, findings[], stores[] }`), `formatReport(result)`.

## How to test

`pnpm --filter @platform/core test -- src/bootstrap` — seeded throwaway database: ready; revoking the seeded
brand-a key turns `ok` false with a `store_api_key` / `seed_keys` finding; a migrated-but-unseeded database reports
the missing organization; an empty Medusa schema is reported with the migrate command.
