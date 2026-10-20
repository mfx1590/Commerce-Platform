# Memory 14 — Event bus & outbox relay
Window: 14 · Key: `events` · Branch prefix: `events/` · Model: strongest
Last updated: 2026-10-20 (manager, Phase 4 kickoff) · Contracts: contracts-v0.4.26 · Last commit: (none) · Status: not started

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
- [ ] #530 14.1 Redpanda topics + local/CI config
- [ ] #531 14.2 Outbox relay with idempotent delivery
- [ ] #532 14.3 Schema registry + versioning
- [ ] #533 14.4 Consumer SDK + dead-letter queue
- [ ] #534 14.5 Replay CLI + 10k replay test (then the manager tags events-v1)

## Decisions made (with reasons)
- 2026-10-20 (manager): the core's in-process outbox consumers (notification_delivery 0180, customer_export 0195, customer_erasure_claim 0199) stay as they are in Phase 4; the relay publishes every outbox row to the bus IN ADDITION and never touches their claim tables. Moving them onto the bus is a later decision.

## Blocked / waiting
- (none)

## Gotchas learned
- (none yet)

## How to run & test this package
- (fill in after first setup: exact commands)
