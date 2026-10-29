# @platform/analytics-ingest

## Purpose

ClickHouse ingest consumer (Phase 5, #600): every bus topic into `raw_events`, exactly once in effect, invalid or
unknown events to `dlq.<group>`, `--once` drain mode, lag metrics over OpenTelemetry. Design and tests: README.md.

## Owner

window 12 (data).

## Run / test

- `pnpm --filter @platform/analytics-ingest build | typecheck | lint | test`
- `pnpm --filter @platform/analytics-ingest ch:migrate` applies `data/clickhouse/migrations/` then `models/` (lint, lock, idempotent)
- `pnpm --filter @platform/analytics-ingest once` drains to idle and reports
- Live and model tests (`live.test.ts`, `models.test.ts`): `ANALYTICS_LIVE=1` only while holding the machine (ask the manager); CI always runs them. The live test TITLES are pinned by CI (require-live-tests): never rename them.
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/analytics-ingest` before finishing any task.

## Public API

- Consumer group `analytics.raw` (`DEFAULT_GROUP`; override `ANALYTICS_GROUP_ID` / `--group`, which moves the DLQ too)
- `loadConfig`, `createIngest`, `processBatch`, `classify`, `createBatcher`, `createChClient`, `createRawEventsSink`,
  `createChReader`, `migrate`, `readSqlFiles`, `lintSqlFiles`, `createIngestMetrics`, `waitForIdle`; types `RawEventRow`, `IngestConfig`, `OnceReport`

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs or in ClickHouse. ClickHouse SQL lives in `data/clickhouse/`, never inline DDL.
- Offsets are committed only after the ClickHouse insert and the DLQ write are acknowledged.
- Update README.md and CHANGELOG.md with every change.
