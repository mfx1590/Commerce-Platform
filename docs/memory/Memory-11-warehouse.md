# Memory 11 — Shared warehouse / WMS
Window: 11 · Key: `warehouse` · Branch prefix: `warehouse/` · Model: Sonnet
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/hq-warehouse/**`
- `apps/wms-adapter/**`
Reads:
- packages/events
- inventory module public API
Never touches:
- inventory internals

## Mission — Phase 3 (Multi-store & HQ)
Multi-brand allocation rules over shared stock locations, Odoo Inventory (or WMS) integration, scanner pick/pack flows, cycle counts.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 3
- [ ] Allocation policy engine
- [ ] WMS adapter (Odoo Inventory)
- [ ] Scanner flows
- [ ] Cycle counts + reconciliation

## Decisions made (with reasons)
- (none yet)

## Blocked / waiting
- (none)

## Gotchas learned
- (none yet)

## How to run & test this package
- (fill in after first setup: exact commands)
