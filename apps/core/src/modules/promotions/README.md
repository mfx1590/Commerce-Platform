# promotions (window 9)

Pricing and promotions of one store: task 2.4 (#137) the **price lists**, task 2.5 (#138) the **promotion /
coupon rule engine**. Window 1's cart consumes both through `index.ts` only.

## Owner and placement

Window 9 (search). Path: `apps/core/src/modules/promotions/**`. **Placement decision (manager, 2026-09-08):
price lists live here** — `docs/domain.md` labels the `price_list` / `price` / `customer_group` tables
"window 1 (pricing)", but issue #137 assigns the work to window 9, whose owned module that fits pricing is
`promotions`; the cart consumes price resolution and promotion evaluation from one public API.

## Price lists (task 2.4)

Admin operations are the **existing** contract operations (tag `pricing`, contracts-v0.3 — no contract change):
`listPriceLists` (`viewer`), `createPriceList` (`store_admin`), `upsertPrices` (`store_admin`). `pricingRouter()`
reads the `x-permission` and request-body schema from `admin-api.yaml` (`loadSpec`), exactly like window 1's
admin routes; window 1 mounts it next to `adminRouter()` (REQUEST issue). Not in the contract, so not built:
update/delete of a list, CSV import.

- **Create**: currency must be enabled on the store (`store_currency`, 400), customer group / sales channel
  must belong to the store (400), `ends_at > starts_at` (400). Unique `code` per store and the one-`default`-
  per-(store, currency) partial index answer 409. Audit `price_list.create`.
- **Upsert prices** (`PUT …/price-lists/{id}/prices`): bulk, `ON CONFLICT (price_list_id, variant_id,
min_quantity)`; every variant must belong to the store (400 with the ids), duplicate (variant, min_quantity)
  pairs in one payload → 400, `price.currency` is forced to the list's currency, amounts are integer minor
  units (spec + service). Idempotent. Audit `price.upsert`.
- **No events**: `packages/events` 0.2.0 has no price topics, and the search index reads prices only at reindex
  time — a price change reaches the index on the next **full** reindex (documented in the search README). If a
  price event becomes necessary (incremental index updates on price changes), that is a `CONTRACT CHANGE:` on
  packages/events.

## Resolution (`resolvePrices` — what the cart calls)

`resolvePrices(clientOrTx, storeId, { variantIds, currency, quantity?, customerGroupIds?, salesChannelId?,
at? })` → `Map<variant_id, { amount_minor, compare_at_minor, currency, price_list_id, list_type }>`.

- **Applicable lists**: status `active`, matching currency (`store_currency`-enabled currencies only ever get
  lists), `starts_at <= at < ends_at` (missing bound = open), a list bound to a customer group applies only
  when that group is in `customerGroupIds`, a list bound to a sales channel only on that channel. `draft`,
  `expired` and out-of-window lists are ignored regardless of priority.
- **Rank** (issue #137: sale > group > default): list type `sale` (3) > `override` — the "group list" type —
  (2) > `default` (1); within a rank, higher `priority` first; within the winning list the row with the
  greatest `min_quantity <= quantity` (tiered pricing); remaining ties break on the lower amount, then the list
  id, so the result is deterministic.
- A variant with no applicable price in the currency is **absent** from the result: not sellable there (same
  rule as the catalog read model and the search index).
- Takes a `Queryable` too, so the cart can run it inside its own transaction.

The catalog read model and the search index still price from the default list only; adopting `resolvePrices`
for PLP/PDP sale prices is window 1's call site (REQUEST issue) — the module deliberately does not reach into
catalog code.

## Promotions and coupons (task 2.5 — contract change #189, "jsonb" decision)

Types `percentage` (value = basis points), `fixed_amount` (value = minor units, needs an enabled currency),
`free_shipping` (flag for the cart's shipping line), `buy_x_get_y` (`rules.buy_quantity` / `get_quantity` /
`get_discount_bp`, 10000 = free; the CHEAPEST eligible units are the discounted ones). `stackable` /
`exclusive` and the buy-X-get-Y numbers are stored **inside the `rules` jsonb column** (no migration; the API
lifts the first two to top level); the one db statement #189 needs — widening the `type` CHECK — lives at
`proposed/0131_promotion_type_buy_x_get_y.sql` and is applied by the tests until it lands.

- **Admin operations**: `listPromotions` / `createPromotion` are contracts-v0.3 (spec permission); `GET` /
  `PATCH …/promotions/{promotionId}` are #189 (viewer / store_admin, local validation; `code` and `type`
  immutable). Codes are stored and matched upper-case trimmed, unique per store (409). Every rule id
  (products, categories, groups, channels) must belong to the store (400 with the offending list). Audit
  `promotion.create` / `promotion.update`.
- **Engine** (`engine.ts`, pure — no db, no clock): `evaluatePromotions(lines, promotions, ctx)` →
  applied/rejected (machine-readable reasons), total discount, free-shipping flag, and per-line allocations
  that **sum exactly** to each promotion's discount (largest-remainder). Conditions: status/window, usage and
  per-customer limits, min subtotal, product/category eligibility, customer group, sales channel, first order,
  code matching (case-insensitive; unknown code → `not_found`). **Stacking**: the best applicable `exclusive`
  wins over everything and applies alone; otherwise the better of (best non-stackable alone) vs (all
  stackables combined). Applications are then spent against a **per-line budget**: a line absorbs at most its
  own subtotal across all promotions together, a promotion that overshoots a line spills the remainder onto its
  other eligible lines, and whatever still does not fit is dropped from that promotion's discount. The
  cart-level bound follows from this rather than being a separate rule — a cart-level cap alone let two
  overlapping stackables both spend the same line's value (post-merge review of #188).
- **`ctx.at` is required**: the caller passes its own transaction time, so a quote and the placement that
  follows judge every window with the same clock.
- **Usage** (`recordPromotionUse(tx, storeId, promotionId)`): atomic increment refusing past `usage_limit`
  with 409 `conflict` — the cart calls it inside its placement transaction, once per applied promotion, so a
  failed placement never burns a use. Per-customer counts come from the caller (`ctx.customerUses`); the
  module stores no per-customer table.
- **Report provider** (`promotionReportData(client, storeId, from, to)`, the `getPromotionReport` shape):
  uses / discount given / revenue per code over non-cancelled orders in the window, read from the `"order"`
  read model (`promotion_codes`, `discount_minor`, `total_minor` — window 1's table, reads allowed). Caveat:
  an order with several codes counts its full discount and revenue under each (per-code attribution of a
  shared discount is not stored). Window 17 owns the route and calls this through the public API.

## Tests

`pricing.test.ts` (5): routes with spec-driven permissions (analyst lists, store_staff 403 on create, spec 400s),
currency-enabled 400 / duplicate-code 409 / second-default 409 / foreign group 400 / bad window 400, upsert
(foreign variant, payload duplicates, non-integer, 404, idempotent re-run, currency forced), the resolution
matrix (sale beats default and group, priority wins within a rank, expired + draft ignored at priority 99,
group list needs the group, tiers at quantity 5 vs 4, `ends_at` exclusive, unknown currency → absent, fallback
to the seeded default), RLS isolation for brand-b.

`engine.test.ts` (8, pure): allocation sums exactly for arbitrary totals, percentage/fixed/free-shipping/
buy-X-get-Y discounts, every condition gate (with the passing counterpart), code matching + per-customer
limit, stacking matrix (stackables combine, better single wins, exclusive beats everything), subtotal cap, and the
per-line budget: no allocation exceeds its line total, a blocked share spills to the promotion's other eligible
lines, and the invariant holds across every fixture combination.

`promotions.test.ts` (7, DB + routes): jsonb round trip of stackable/exclusive, seeded-WELCOME10 duplicate
409, type/rule validation incl. foreign ids, list/sort/patch (code immutable, RLS 404), candidate loading,
atomic usage counting to the limit (409 `conflict`), another store's code reported `not_found` rather than
silently discounting, the report over fixture orders (cancelled and out-of-window excluded).

Run: `cd apps/core && pnpm exec vitest run src/modules/promotions` (Postgres 5433; creates `core_pricing_*` /
`core_promo_*`).

## Public API (`index.ts`)

Pricing: `listPriceLists`, `createPriceList`, `upsertPrices`, `resolvePrices`, `pricingRouter` (+ types).
Promotions: `evaluatePromotions`, `allocateAcrossLines`, `eligibleLines`, `listPromotions`, `getPromotion`,
`createPromotion`, `updatePromotion`, `loadCandidatePromotions`, `recordPromotionUse`, `promotionReportData`,
`promotionsRouter` (+ types `Promotion`, `PromotionInput`, `PromotionPatch`, `CartLineInput`,
`EvaluationContext`, `EvaluationResult`).
