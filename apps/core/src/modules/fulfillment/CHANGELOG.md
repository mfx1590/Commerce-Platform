# Changelog — fulfillment module (window 8)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this file is
the module's own history (linked from the PRs).

## Phase 2 — shipping/phase2 (contracts-v0.4.2)

### 2026-09-19 · 2.5 Pick/pack lifecycle, events and admin operations (#133, CONTRACT CHANGE #225)

- `lifecycle.ts` (new): `pickShipment`, `packShipment` and `listPickLists`. Pick and pack are real
  `shipment.status` values (#225), so a shipment has one state; each legal move writes one event in the same
  transaction. Skips forward are legal (`pending → packed` for a store that does not pick), backwards is not, and
  an operator's illegal move is a 409 — `applyTransition` writes what it is told, so the check lives here.
- `lifecycle-events.ts` (new): the seam for `fulfillment.requested` / `.picking` / `.packed`. It writes to the
  outbox as soon as `@platform/events` knows the topic and buffers with one warning until then, because events
  0.3.0 is part of #225 and not on main yet. Nothing changes on the day it lands.
- `http.ts` (new): `fulfillmentAdminRouter()` with the three operations. Permissions are read from
  `admin-api.yaml` when it has them and from `proposed/admin-api.pick-pack.yaml` (#225, verbatim) until 0.4.3
  lands. The two shipment paths resolve the shipment's store first, so a shipment in another organization is a
  404 — never a 403 or a leak.
- `service.ts`: `cancelFulfillment` records a divergence on the reference when the provider cancels but the
  shipment cannot, instead of swallowing it; `applyFulfillmentUpdate` moves the shipment before recording the
  provider state, so a failed move leaves the reference where a retry expects it.
- Tests: 22 more (lifecycle, pick lists, the router, the two divergence regressions).

### 2026-09-15 · 2.4 3PL adapter interface, in-memory implementation, per-warehouse routing (#132)

- `routing.ts` (new): `routeFulfillment`, a pure function over the organization's active warehouses. Rules in
  order: store override by destination country, store default, same country, same region (static map: Europe incl.
  GB/CH/NO, North America), lowest priority. Store settings name warehouses by `code`; an unknown code is ignored.
  The decision carries the rule that won.
- `types.ts` (new): `FulfillmentProvider` (`push`, `status`, `cancel`), `FulfillmentRequest` / `FulfillmentUpdate`
  in ids, SKUs and quantities, `FulfillmentError` without addresses.
- `memory-provider.ts` (new): the in-memory 3PL — forward-only progress, a free cancel only before picking,
  tracking required to ship, `failNextPush()` for compensation tests. Bounded job index.
- `registry.ts` (new): `store.settings.fulfillment.provider` names the provider; `memory` is the default and the
  fallback for an unregistered name.
- `service.ts` (new): `requestFulfillment` (route → plan shipment → push outside any transaction → record the
  reference on `shipment.metadata.fulfillment`; a failed push cancels the shipment and releases its stock, 502),
  `cancelFulfillment` (provider first; refused after picking is a 409 and nothing changes; otherwise the shipment is
  cancelled and stock released), `applyFulfillmentUpdate` (idempotent; `shipped` moves the shipment with tracking).
- Shipping module: `readShipmentMetadata` / `writeShipmentMetadata` added to its public API for the reference.
- README documents the mapping to a real 3PL API.
- Tests: 16 unit tests and 9 on a seeded database.
