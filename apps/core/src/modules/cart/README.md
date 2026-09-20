# cart — Store API cart (window 1, task 2.1, issue #103)

The contract cart (`packages/contracts/openapi/store-api.yaml` 0.3.0, tag `cart`) over our `cart` and
`cart_line_item` tables (packages/db migration 0006), one transaction per use case on a store-scoped client. The
HTTP routes live in `src/http/store-routes.ts`; this module never sees Express.

## Public API (`index.ts`)

| Function                                                   | Contract operation                                     | Notes                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCart(client, ctx, input?)`                          | `POST /store/carts` → 201                              | currency must be one of the store's (`store_currency`), else 400; country/locale default to the store's; sales channel = the key's, else the active `web` channel; metadata stored as given |
| `getCart(client, cartId)`                                  | `GET /store/carts/{cartId}`                            | a cart of another store is invisible under RLS → 404 `not_found` (never 403)                                                                                                                |
| `updateCart(client, cartId, input)`                        | `PATCH /store/carts/{cartId}`                          | only the fields present change; `metadata` replaces the stored object whole; `promotion_codes` normalised (trim, dedupe case-insensitively); an unavailable `shipping_option_id` → 400      |
| `addLineItem(client, cartId, { variant_id, quantity })`    | `POST /store/carts/{cartId}/line-items`                | variant must be a published variant of the store with a default-list price in the cart currency (400 otherwise); same variant again → quantity added to the existing line                   |
| `updateLineItem(client, cartId, lineItemId, { quantity })` | `PATCH /store/carts/{cartId}/line-items/{lineItemId}`  | 404 when the line is not in this cart                                                                                                                                                       |
| `removeLineItem(client, cartId, lineItemId)`               | `DELETE /store/carts/{cartId}/line-items/{lineItemId}` | 404 when the line is not in this cart                                                                                                                                                       |
| `setTaxCalculator` / `setShippingRateProvider`             | —                                                      | pricing seams, see below                                                                                                                                                                    |

Also exported for the checkout module (window 1, same tables, same transaction): `loadCart`, `lockActiveCart`,
`loadLines`, `recalculate`, `renderCart`, `assertLinesInStock` and the row types — not for other windows.

`ctx` is `{ organizationId, storeId, salesChannelId }` (the HTTP layer passes the fields of `req.tenant`). Every
mutation on a cart whose `status` is not `active` → 409 `cart_completed` (`details: { cart_id, status, order_id }`).
Reads keep working on completed carts (the storefront's confirmation page).

## Totals

Every mutation locks the cart row (`SELECT … FOR UPDATE`), applies the change and calls `recalculate()` in the same
transaction. Integer minor units everywhere; nothing is a float.

| Amount            | Rule                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| line `unit_price` | the `PriceResolver` price for the line's CURRENT quantity (default: the store's default list, greatest `min_quantity <= quantity`; the server registers window 9's price lists: sale > group/override > default). Every line mutation re-prices the whole cart   |
| line `subtotal`   | `quantity × unit_price`                                                                                                                                                                                                                                          |
| line `discount`   | the `DiscountEvaluator`'s allocation for the line (`cart_line_item.discount_minor`), in the cart's own price base, never above the line subtotal; computed BEFORE shipping and tax. Default `noDiscounts` = 0; the server registers window 9's promotions engine |
| line `tax`        | the `TaxCalculator`'s own amount for the line as last calculated (`metadata.tax.amount_minor`, read through `lineTaxOf`) — never recomputed from `tax_rate_bp` (#221)                                                                                            |
| line `total`      | exclusive prices: `subtotal − discount + tax`; `prices_include_tax`: `subtotal − discount` (the tax is inside)                                                                                                                                                   |
| `shipping`        | the `ShippingRateProvider` quote for `shipping_option_id` (0 without a selection, 0 when a promotion grants free shipping)                                                                                                                                       |
| `tax`             | Σ `TaxCalculator` line tax + shipping tax                                                                                                                                                                                                                        |
| `total`           | exclusive prices: `subtotal − discount + shipping + tax`; `prices_include_tax`: `subtotal − discount + shipping` (tax reported, not added)                                                                                                                       |

Prices are **tax-exclusive** (owner decision 2026-09-08; tax-inclusive display is a later store setting). Stock:
adding or raising a line beyond the summed `inventory_level.available` of active warehouses → 409 `out_of_stock`
`{ variant_id, available }` when the variant `manage_inventory` and not `allow_backorder` (reservations are task 2.4).
A country change re-runs both providers: a shipping option no longer quotable for the new destination is dropped
(shipping back to 0) rather than failing the request; setting an unavailable option explicitly is a 400.

## Pricing providers (seams for windows 7 and 8)

```ts
import { setTaxCalculator, setShippingRateProvider } from '../cart'; // from another module: '../modules/cart'

setTaxCalculator(stripeTaxCalculator); // window 7, #127 — returns the previous calculator
setShippingRateProvider(easyPostRates); // window 8, #130 — returns the previous provider
```

- `TaxCalculator.calculate({ tx, organizationId, storeId, salesChannelId, currency, country, shippingAddress, lines, shippingMinor })`
  → `{ lines: [{ lineItemId, taxRateBp, taxMinor }], shippingTaxMinor }`. `taxRateBp` is persisted on the line
  (`cart_line_item.tax_rate_bp`); `taxMinor` is persisted next to it (`metadata.tax`) and drives both the line
  display and the cart total (#221). `ctx.pricesIncludeTax` tells the calculator the store's mode. Default
  `tableTaxCalculator`: our `tax_rate` table by `cart.country` — the line's category over a store-wide rate, a
  `region` match (from the shipping address) over `region IS NULL`; no row → 0 bp; shipping untaxed.
- `ShippingRateProvider.list(ctx)` / `.quote(ctx, optionId)` → `{ optionId, code, name, carrier, priceMinor, currency }`
  or `null` when the option is not available for the cart. Default `tableShippingRates`: active `shipping_option`
  rows of the store in the cart currency whose `countries` contain the destination (empty = everywhere) and whose
  sales channel is unset or the cart's; flat `price_minor`. Task 2.2's `listShippingOptions` uses `list()`.
- Both run inside the mutation's transaction through `ctx.tx` (RLS scope = the store). Set once at boot from the
  owning module; the registry is process-wide.

## Abandoned carts (task 2.6, `abandoned.ts`)

`markAbandonedCarts(client, { now, idleForMs, batchSize? })` / `markAllAbandonedCarts(...)`: every `active` cart with
at least one line and `updated_at < now − idleForMs` becomes `abandoned` and emits ONE `cart.abandoned` v1
(`cart_id`, `customer_id`, `email_hash` = sha256 of the lowercased email or null, `currency`, `total_minor`,
`line_item_count`, `last_activity_at` = the cart's `updated_at`, `abandoned_at` = now, `has_attribution`) in the
same transaction. Rows are taken with `FOR UPDATE SKIP LOCKED`, so two concurrent runs never double-process. The
clock is injected; the job in `src/jobs/abandoned-carts.ts` supplies it (Medusa scheduled job under
`MEDUSA_WORKER_MODE = shared | worker`, cron `CORE_ABANDONED_CART_CRON` default hourly, threshold
`CORE_ABANDONED_CART_AFTER_HOURS` default 6, one organization-scoped pass for every store; also a one-shot CLI).

**Reactivation**: any mutation on an `abandoned` cart flips it back to `active` and touches `updated_at`
(`lockActiveCart`), so the idle clock restarts and the cart is abandoned again only after a full idle period — that
later abandonment is a new event. A `completed` cart still answers 409 `cart_completed`. Empty carts are never
abandoned (nothing to recover).

## Decisions (ADR-style; the main window moves them to docs/adr)

- **2026-09-19 · Discounts come through a `DiscountEvaluator` seam, before shipping and tax (#230 PR A).**
  `setDiscountEvaluator()` follows the price/tax/shipping pattern (default `noDiscounts`); the server registers
  `promotionsDiscountEvaluator` (`src/wiring.ts`) over window 9's engine — candidates = automatic promotions + the
  cart's codes, judged at the mutation's clock, with the customer's groups, first-order state and prior uses (a
  guest has none). `recalculate` order: discounts → shipping (free when a promotion says so) → tax on the
  discounted base → totals. **Codes**: entering a code that can NEVER apply to this cart (`not_found`,
  `not_active`, `expired`, `usage_limit_reached`, `per_customer_limit_reached`, `wrong_currency` — the currency is
  fixed at cart creation and exhaustion does not heal) is a 400 `validation_error` with `details.promotion_codes = { CODE: reason }` and the whole
  PATCH rolls back; a conditional rejection (minimum subtotal, eligible lines, group, channel, first order, and `not_started` — time,
  not the cart, makes a launch code applicable) keeps
  the code and it applies once the cart qualifies. The evaluator says which is which (`rejected[].permanent`) —
  the cart knows no reason names. **Tax-inclusive stores** (manager decision + ruling on #243): the engine always works in
  tax-exclusive money, and everything a merchant configures or a customer sees is GROSS. OUR adapter converts
  both ways through `taxOn`: unit prices gross → net; a fixed amount gross → net at the blended rate of its
  eligible lines, its allocations brought back to sum to EXACTLY `min(configured amount, eligible lines' displayed
subtotal)` — each share clamped to its line, the rounding drift spread only where there is headroom ("5.00 off"
  is 5.00 off the displayed total); a `min_subtotal` compared against the DISPLAYED cart subtotal; percentages converted per line
  (the same percentage of what the customer sees). For that conversion `recalculate` asks the TaxCalculator
  for the lines' rates once before discounting (tax-inclusive stores only).

- **2026-09-19 · Unit prices come through a `PriceResolver` seam, and every line mutation re-prices the cart
  (#179 part 3).** `setPriceResolver()` follows the tax/shipping pattern: the default
  (`defaultListPriceResolver`) reads the store's default list tiered by quantity; the server registers
  `priceListResolver` (`src/wiring.ts`) over window 9's `resolvePrices` — sale > group/override > default,
  priority, date windows, sales channel, the customer's group. A seam rather than an import because
  `promotions → http → module-routers → payments → checkout → cart` would close an import cycle, and because the
  cart must not know who owns price lists (guard test). `repriceLines(tx, cart, { at, apply })` re-resolves every
  line at its current quantity on add / update / remove; a variant with no price in the currency is a 400 for the
  line being changed and is left alone on other lines — placement reports it.

- **2026-09-19 · A line's tax is the calculator's amount, kept per line; tax-inclusive stores (#221, window 7).**
  `recalculate` stores each line's last calculation in `cart_line_item.metadata.tax = { amount_minor, mode, bp }`
  (one namespaced object, so a later `tax_minor` column is a mechanical migration) and every reader goes through
  `lineTaxOf(row)` — the cart line, the order line frozen at placement and `order.placed` all show the
  calculator's own amount, never `taxOn(base, tax_rate_bp)` again (a provider such as Stripe Tax rounds per line
  in its own way; Σ line tax + shipping tax = `tax_minor` by construction). Why metadata and not the two
  alternatives: recomputing at render would call the provider on every cart read; a column needs a contract round
  trip for no behavioural gain. Line metadata is internal — no Store API shape renders it (tested over HTTP).
  `store.settings.tax.prices_include_tax` (default false) reaches calculators as `PricingContext.pricesIncludeTax`:
  the tax is then CONTAINED in the prices — reported in `totals.tax`, never added on top
  (`total = subtotal − discount + shipping`, line `total = subtotal − discount`). `taxOn(base, bp, included)` is
  the one rounding rule (half up) for both modes; `tableTaxCalculator` honours the flag. A cart is re-priced in the
  store's current mode on its next mutation; a placed order keeps the mode frozen on its lines.

- **2026-09-09 · Abandoned = idle, reactivation resets the clock, a new abandonment is a new event** (manager, 2.6);
  `updated_at` is deliberately NOT touched by the job so `last_activity_at` stays the customer's last action.

- **2026-09-08 · Carts bypass Medusa's cart module** (owner decision deferred from task 1.8, accepted by the manager
  at the start of 2.1). The contract cart is `public.cart` / `cart_line_item`: `organization_id` + `store_id` on
  every row, RLS, integer minor units, `metadata` round-trip, the columns `order.placed` needs at placement. Medusa's
  cart lives in schema `medusa` with no tenant scoping, no outbox and a different shape; our contract routes already
  answer ahead of Medusa's. Consequence: no Medusa mirror of stores, channels or publishable keys is needed at all —
  the 1.8 "mirror" question is closed; `src/bootstrap` stays a read-only verifier.
- **2026-09-08 · Prices are tax-exclusive; tax and shipping pricing sit behind interfaces** (manager requirement so
  windows 7/8 never edit this module). Superseded on two points by the 2026-09-19 decision above (#221): a line
  shows and freezes the calculator's own amount (no recompute from `tax_rate_bp`, so no minor-unit drift), and
  tax-exclusive is the default, not the only mode.
- **2026-09-08 · Promotion codes are accepted and stored, not validated** until window 9's promotions public API
  exists (`apps/core/src/modules/promotions/index.ts`); discount stays 0. When it lands, `recalculate()` gets a
  third provider call between shipping and tax; the stored codes need no migration.
- Carts emit **no events** (docs/domain.md: not accounting-relevant); `cart.abandoned` is task 2.6's job.

## Tests

`cart.test.ts` (14, seeded throwaway database): store defaults + metadata round-trip, currency rule, sales-channel
fallback, add/increase/update/remove totals against the persisted row, 409 `out_of_stock` and backorder bypass,
400 unknown/foreign/unpriced variant, `updateCart` fields + promotion-code normalisation, shipping option priced /
refused / dropped on country change, 409 `cart_completed`, RLS 404 from store B, replaced tax and shipping providers,
`taxOn` rounding. HTTP contract replay of every operation: `test/store-api.test.ts`.
