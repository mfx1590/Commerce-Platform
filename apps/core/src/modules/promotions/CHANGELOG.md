# Changelog — promotions module (window 9)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — search/phase2 (contracts-v0.3)

### 2026-09-08 · 2.4 Price lists (#137)

- Module created (placement decision in README.md: the pricing half of promotions, consumed by the cart
  through `index.ts`).
- `pricing.ts`: `listPriceLists`, `createPriceList` (currency enabled on the store, group/channel of the store,
  window check; 409s from the unique code and one-default-per-currency constraints; audit `price_list.create`),
  `upsertPrices` (bulk `ON CONFLICT`, variants of the store, payload duplicates 400, list currency forced,
  idempotent; audit `price.upsert`), `resolvePrices` (sale > override/group > default, priority within a rank,
  active + in-window only, group and channel binding, tiered `min_quantity`, deterministic tie-breaks; accepts
  a `Queryable` for the cart's transaction).
- `pricing-http.ts`: `pricingRouter()` — permissions and request bodies straight from `admin-api.yaml`
  (`listPriceLists`, `createPriceList`, `upsertPrices` exist in contracts-v0.3; no contract change). Mount
  line → window 1 (REQUEST).
- Tests: `pricing.test.ts` (5).
- Not built (not in the contract): list update/delete, CSV import. No price events (none exist in events 0.2.0);
  price changes reach the search index at the next full reindex.
