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

`ctx` is `{ organizationId, storeId, salesChannelId }` (the HTTP layer passes the fields of `req.tenant`). Every
mutation on a cart whose `status` is not `active` → 409 `cart_completed` (`details: { cart_id, status, order_id }`).
Reads keep working on completed carts (the storefront's confirmation page).

## Totals

Every mutation locks the cart row (`SELECT … FOR UPDATE`), applies the change and calls `recalculate()` in the same
transaction. Integer minor units everywhere; nothing is a float.

| Amount            | Rule                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| line `unit_price` | default-list price (`price_list.type = 'default'`, `status = 'active'`, cart currency, `min_quantity = 1`) snapshotted at first add |
| line `subtotal`   | `quantity × unit_price`                                                                                                             |
| line `discount`   | `cart_line_item.discount_minor` — 0 until window 9's promotions API prices the stored codes                                         |
| line `tax`        | `round_half_up((subtotal − discount) × tax_rate_bp / 10000)` from the persisted `tax_rate_bp` (`taxOn()`)                           |
| line `total`      | `subtotal − discount + tax`                                                                                                         |
| `shipping`        | the `ShippingRateProvider` quote for `shipping_option_id` (0 without a selection)                                                   |
| `tax`             | Σ `TaxCalculator` line tax + shipping tax                                                                                           |
| `total`           | `subtotal − discount + shipping + tax`                                                                                              |

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
  (`cart_line_item.tax_rate_bp`) and drives the per-line display; `taxMinor` drives the cart total. Default
  `tableTaxCalculator`: our `tax_rate` table by `cart.country` — the line's category over a store-wide rate, a
  `region` match (from the shipping address) over `region IS NULL`; no row → 0 bp; shipping untaxed.
- `ShippingRateProvider.list(ctx)` / `.quote(ctx, optionId)` → `{ optionId, code, name, carrier, priceMinor, currency }`
  or `null` when the option is not available for the cart. Default `tableShippingRates`: active `shipping_option`
  rows of the store in the cart currency whose `countries` contain the destination (empty = everywhere) and whose
  sales channel is unset or the cart's; flat `price_minor`. Task 2.2's `listShippingOptions` uses `list()`.
- Both run inside the mutation's transaction through `ctx.tx` (RLS scope = the store). Set once at boot from the
  owning module; the registry is process-wide.

## Decisions (ADR-style; the main window moves them to docs/adr)

- **2026-09-08 · Carts bypass Medusa's cart module** (owner decision deferred from task 1.8, accepted by the manager
  at the start of 2.1). The contract cart is `public.cart` / `cart_line_item`: `organization_id` + `store_id` on
  every row, RLS, integer minor units, `metadata` round-trip, the columns `order.placed` needs at placement. Medusa's
  cart lives in schema `medusa` with no tenant scoping, no outbox and a different shape; our contract routes already
  answer ahead of Medusa's. Consequence: no Medusa mirror of stores, channels or publishable keys is needed at all —
  the 1.8 "mirror" question is closed; `src/bootstrap` stays a read-only verifier.
- **2026-09-08 · Prices are tax-exclusive; tax and shipping pricing sit behind interfaces** (manager requirement so
  windows 7/8 never edit this module). Line tax display derives from the persisted `tax_rate_bp`; the cart total uses
  the calculator's amounts, so a provider with its own rounding can differ from the line display by a minor unit —
  acceptable for the cart, and `order_line_item.tax_minor` is written exactly at placement (2.2).
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
