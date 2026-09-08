# Memory 8 — Shipping & fulfillment
Window: 8 · Key: `shipping` · Branch prefix: `shipping/` · Model: Sonnet
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `shipping/phase2` · Status: not started (Phase 2)

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/fulfillment/**`
- `apps/core/src/modules/shipping/**`
Reads:
- packages/contracts
- packages/events
Never touches:
- other core modules

## Mission — Phase 2 (Commerce complete, brand 1 live)
EasyPost/ShipEngine provider (rates, labels, tracking webhooks), 3PL adapter interface with in-memory impl, pick/pack state machine, shipment events on the outbox. Wave B — starts when core 2.1–2.2 have merged.

## Done
- (nothing yet)

## In progress
- (nothing — Phase 2 starts with the first item under Next)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [ ] **#129 · 2.1** Carrier provider interface + EasyPost (test mode)
- [ ] **#130 · 2.2** Rate shopping at checkout
- [ ] **#131 · 2.3** Labels and tracking webhooks
- [ ] **#132 · 2.4** 3PL adapter interface + in-memory implementation
- [ ] **#133 · 2.5** Pick/pack state machine and events

## Decisions made (with reasons)
- (none yet)

## Blocked / waiting
- (none)

## Gotchas learned
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package
- (fill in after first setup: exact commands)
