# @platform/analytics-ingest

## Purpose

ClickHouse ingest consumer (Phase 5). Streams every bus event into ClickHouse for live dashboards. Scaffold only.

## Owner

window 12 (data).

## Run / test

- `pnpm --filter @platform/analytics-ingest build` — compile to dist/
- `pnpm --filter @platform/analytics-ingest typecheck`
- `pnpm --filter @platform/analytics-ingest test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/analytics-ingest` before finishing any task.

## Public API

- Consumer group: analytics.all; idempotent on event_id

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.

## Phase 0 note

This is a scaffold: package.json, tsconfig, an empty index.ts. The owning window replaces it with the real
framework setup (Medusa 2 / Next.js) in its first Phase 1 task. Keep the package name and the CLAUDE.md sections.
