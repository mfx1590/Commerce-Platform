# promotions (window 9)

Pricing and promotions of one store. Phase 2 task 2.4 (#137) delivers the **price-list half**; task 2.5 (#138)
adds the promotion / coupon rule engine to this same module. Window 1's cart consumes both halves through
`index.ts` only.

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

## Tests

`pricing.test.ts` (5): routes with spec-driven permissions (analyst lists, store_staff 403 on create, spec 400s),
currency-enabled 400 / duplicate-code 409 / second-default 409 / foreign group 400 / bad window 400, upsert
(foreign variant, payload duplicates, non-integer, 404, idempotent re-run, currency forced), the resolution
matrix (sale beats default and group, priority wins within a rank, expired + draft ignored at priority 99,
group list needs the group, tiers at quantity 5 vs 4, `ends_at` exclusive, unknown currency → absent, fallback
to the seeded default), RLS isolation for brand-b.

Run: `cd apps/core && pnpm exec vitest run src/modules/promotions` (Postgres 5433; creates `core_pricing_*`).

## Public API (`index.ts`)

`listPriceLists`, `createPriceList`, `upsertPrices`, `resolvePrices`, `pricingRouter`, and the types
`PriceList`, `PriceListInput`, `PriceUpsertRow`, `ResolveQuery`, `ResolvedPrice`.
