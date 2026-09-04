# @platform/accounting

## Purpose

Ledger service (Phase 4). Consumes events from @platform/events and produces double-entry journal entries per store and legal entity, then posts to Odoo. Never reads UI state. Scaffold only.

## Owner

window 15 (accounting).

## Run / test

- `pnpm --filter @platform/accounting build` — compile to dist/
- `pnpm --filter @platform/accounting typecheck`
- `pnpm --filter @platform/accounting test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/accounting` before finishing any task.

## Public API

- Consumer groups: accounting.orders, accounting.payments, accounting.refunds
- Output table: ledger_entry (organization_id + legal_entity_id + store_id)

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.

## Phase 0 note

This is a scaffold: package.json, tsconfig, an empty index.ts. The owning window replaces it with the real
framework setup (Medusa 2 / Next.js) in its first Phase 1 task. Keep the package name and the CLAUDE.md sections.
