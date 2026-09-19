# Changelog — fulfillment module (window 8)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this file is
the module's own history (linked from the PRs).

## Phase 2 — shipping/phase2 (contracts-v0.4.1)

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
