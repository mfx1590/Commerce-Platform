# Changelog — @platform/core

## Unreleased — Phase 1 (window 1, contracts-v0.1)

### 2026-09-05 · task 1.2 — registry module (issue #2)

- `src/modules/registry`: stores (list/get/create/update), domains (one primary), locales/currencies (one default,
  mirrored on the store), sales channels, API keys (plain key returned once, sha256 stored) over the frozen 0003
  schema. Every mutation: one transaction with `audit_log` and, for stores, `store.created` / `store.updated`.
- `src/outbox/with-events.ts`: first cut of `withEvents(tx, events[])` (schema validation, same-transaction
  insert; hardened in task 1.5). `src/lib/audit.ts` (`writeAudit`, Phase 1 stub for the auth-sdk helper),
  `src/lib/errors.ts` (`AppError` with contract codes, pg unique/FK violation mapping).
- Tests: 9 registry cases on a throwaway database as `platform_app` (RLS), incl. rollback on an invalid event.

### 2026-09-04 · task 1.1 — Medusa 2 boots against the Phase 0 stack (issue #1)

- Medusa 2.20.1 project: `medusa-config.ts` (schema `medusa`, `DATABASE_URL_APP`, Redis cache + event bus,
  admin dashboard off), CommonJS tsconfig (`module: NodeNext`), Vitest config.
- `src/server.ts`: Express app with `/health` and the `X-Publishable-Key` → `x-publishable-api-key` alias mounted
  ahead of Medusa's loaders; graceful shutdown.
- `src/lib/db.ts`: the single pool (`platform_app`) and `tenantClient` / `organizationClient` from `@platform/db`.
- `scripts/db-medusa-migrate.ts`: role `medusa_owner` + schema `medusa` + default privileges, Medusa migrations
  as that role (in-process), catch-up grants for `platform_app`. `search_path` pinned via `databaseDriverOptions`.
- README (two schemas, module layout, how a module gets a tenant client), CLAUDE.md run/test commands.

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
