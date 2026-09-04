# @platform/events

## Purpose

Versioned JSON Schemas for every domain event (order.placed, payment.captured, ...), generated TypeScript types, an envelope definition, an Ajv validator, and the outbox table migration used by apps/core.

## Owner

main window only (window 14 events gets a phase-4 exception, see docs/ownership.md).

## Run / test

- `pnpm --filter @platform/events build` — compile to dist/
- `pnpm --filter @platform/events typecheck`
- `pnpm --filter @platform/events test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/events` before finishing any task.

## Public API

- `schemas/<topic>/v<N>.json` — one schema per event version
- `import { EVENT_TOPICS, validateEvent, type EventEnvelope, type OrderPlacedV1 } from '@platform/events'`
- `pnpm --filter @platform/events generate` regenerates types from schemas

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.
