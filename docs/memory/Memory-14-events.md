# Memory 14 — Event bus & outbox relay
Window: 14 · Key: `events` · Branch prefix: `events/` · Model: strongest
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)
Owned paths (write):
- `apps/core/src/outbox/**`
- `infra/redpanda/**`
- `packages/events/** (exception this phase only)`
Reads:
- everything
Never touches:
- consumers

## Mission — Phase 4 (Events, accounting, CRM)
Redpanda config, outbox relay with idempotent delivery, schema registry, replay CLI, consumer SDK with dead-letter pattern. Replay 10k historical orders in tests. No other Phase 4 window starts before events-v1 is tagged.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 4
- [ ] Redpanda cluster + topics
- [ ] Outbox relay + idempotency keys
- [ ] Schema registry + versioning
- [ ] Consumer SDK + DLQ
- [ ] Replay CLI + test

## Decisions made (with reasons)
- (none yet)

## Blocked / waiting
- (none)

## Gotchas learned
- (none yet)

## How to run & test this package
- (fill in after first setup: exact commands)
