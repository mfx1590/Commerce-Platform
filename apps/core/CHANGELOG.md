# Changelog — @platform/core

## Unreleased — Phase 1 (window 1, contracts-v0.1)

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
