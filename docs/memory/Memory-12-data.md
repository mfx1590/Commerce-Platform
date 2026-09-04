# Memory 12 — Data platform, BI & AI
Window: 12 · Key: `data` · Branch prefix: `data/` · Model: Sonnet
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)
Owned paths (write):
- `data/**`
- `apps/analytics-ingest/**`
- `apps/admin/src/app/(hq)/bi/** (embed only)`
Reads:
- packages/events
- packages/db schema
Never touches:
- core
- rest of admin

## Mission — Phase 3 (Multi-store & HQ)
Reporting v1: Postgres reporting views, Metabase with row-level permissions by allowedStores, embedded in the admin.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 3
- [ ] Reporting views
- [ ] Metabase setup + RLS
- [ ] Embed in admin

## Decisions made (with reasons)
- (none yet)

## Blocked / waiting
- (none)

## Gotchas learned
- (none yet)

## How to run & test this package
- (fill in after first setup: exact commands)

## Later phases (do not start until Memory-main says so)
### Phase 5 — Data platform & AI
ClickHouse ingest for live revenue by store; BigQuery via Airbyte + CDC; dbt models per store + consolidated with tests; Dagster; BI dashboards (finance = ledger); PostHog; AI: vector search, recs, Claude for copy/support/BI Q&A.
- [ ] ClickHouse ingest consumer
- [ ] Warehouse + Airbyte sources
- [ ] dbt models + tests
- [ ] Dagster
- [ ] Dashboards
- [ ] PostHog
- [ ] AI features
