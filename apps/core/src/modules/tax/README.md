# tax — table rates and Stripe Tax behind the cart's `TaxCalculator` (window 7, task 2.4, issue #127)

One cart `TaxCalculator`, registered at boot, that reads the store's tax settings on every pricing pass and
dispatches to a `TaxProvider`: `table` (our `tax_rate` rows — offline, the default) or `stripe` (Stripe Tax,
test mode, same per-store keys as payments). The cart module is never edited: it exposes `setTaxCalculator`
and this module plugs in. Contracts: contracts-v0.4.1 (nothing in packages/\* changes).

## Public API (`index.ts`)

| Export                                                                                                    | Purpose                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerTaxProvider(opts?)`                                                                              | `setTaxCalculator(createTaxCalculator(opts))`; src/server.ts calls it at boot next to `registerPaymentProviders()` (REQUEST #221 / #176). Returns the previous calculator |
| `createTaxCalculator(opts?)`                                                                              | the dispatching calculator; `opts.apiFactory` / `opts.env` / `opts.log` are test seams                                                                                    |
| `tableTaxProvider` / `createStripeTaxProvider(opts?)`                                                     | the two `TaxProvider`s                                                                                                                                                    |
| `taxSettingsFrom(store.settings, { legalEntityCountry })` / `DEFAULT_TAX_SETTINGS` / `TAX_SETTINGS_KEY`   | the store setting reader; the legal entity's country decides the `shipping_taxable` default (#352)                                                                        |
| `EU_COUNTRIES` / `defaultShippingTaxable(country)`                                                        | the EU VAT area and the platform default for delivery VAT                                                                                                                 |
| `shippingTaxAtGoodsRate(shipping, ratedBases, fallbackBp, inclusive)` / `allocateProRata(total, weights)` | delivery tax at the goods' rate(s): one rate → that rate, mixed → pro rata (largest remainder), no taxable goods → the store-wide rate                                    |
| `taxFor(amount, bp, inclusive)`                                                                           | the cart module's `taxOn(amount, bp, included)` — the platform's single rounding seam; this module has no rounding of its own                                             |
| `rateBpOf(stripeLine)`                                                                                    | basis points of a Stripe Tax line                                                                                                                                         |
| `TAX_FALLBACK_FLAG` / `taxFallbackEnabled(env)`                                                           | the outage opt-in (non-production only)                                                                                                                                   |

## Store settings — `store.settings.tax`

```jsonc
{ "tax": { "provider": "table", "prices_include_tax": false, "shipping_taxable": false } }
```

- `provider`: `table` (default) or `stripe`.
- `prices_include_tax`: catalogue prices are gross (EU/UK consumer pricing). Tax is EXTRACTED from the price
  instead of added on top. Default `false` — Phase 2's exclusive pricing (owner decision 2026-09-08).
- `shipping_taxable`: the delivery charge carries tax **at the rate of the goods delivered** (#352). **Default:
  `true` when the store's legal entity is in the EU (`legal_entity.country` ∈ the 27 member states), `false`
  elsewhere** — in the EU the shipping fee is part of the taxable amount of the supply (NL: €4.99 delivery on 21 %
  goods carries €1.05 VAT; a mixed-rate cart apportions the fee pro rata to the goods). An explicit `false` makes
  the store **shipping-exempt** (today's pre-#352 behaviour: no delivery tax from the table provider, and the
  delivery charge is not sent to Stripe Tax either); an explicit `true` taxes delivery anywhere (UK, US stores
  opt in). When the setting is absent and the provider is `stripe`, Stripe Tax decides shipping tax itself — it
  knows the destination's rule — so the two providers agree for EU stores.

Unknown or malformed values fall back to the defaults; reading settings never throws. **With default settings the
registered calculator returns exactly what the cart's built-in `tableTaxCalculator` returns for the LINES**
(tested); the one platform default this module adds on top of the built-in is delivery VAT for EU stores. A store
that must keep untaxed delivery sets `shipping_taxable: false`.

### Delivery VAT — how the amount is computed (#352)

Table provider, `shipping_taxable` on: the goods' rates come from the same lookup as the lines. One rate in the
cart → the whole delivery charge at that rate (`taxOn(shipping, bp, mode)`). Several rates → the charge is split
**pro rata to the lines' taxable bases** (`allocateProRata`: integer minor units, largest remainder, shares add up
to the charge exactly — an allocation of a base amount, like a discount allocation, not a rounding of tax) and
each share is taxed at its rate through `taxOn`; lines with no taxable base (free lines) carry no weight. No
taxable goods at all (a free cart with a paid delivery) → the destination's store-wide rate. Tax-inclusive stores
get the tax CONTAINED in the gross delivery price, same rule. The cart adds `shippingTaxMinor` to `tax_minor` and
the order freezes it in its totals (`order.placed.tax_minor`); the Store API `Totals.tax` already includes it, so
no contract field is needed — the storefront shows one tax line, the manager's example (€34.50 + €4.99 → tax €8.30,
total €47.79) is what a shopper sees.

## Rounding (documented because money)

**One rule for the whole platform: the cart module's `taxOn(base, bp, included)`** (core #224). Integer minor
units, no floats, the TAX rounded half-up, **per line** (and once for shipping) — never on the cart total — so the
amounts frozen on order lines add up to the order's tax. This module calls it and adds no rounding of its own.

- Exclusive: `tax = round(base × bp / 10000)`.
- Inclusive: `tax = round(base × bp / (10000 + bp))` — the tax contained in the gross amount. At a half-cent tie
  the TAX rounds up (gross 9 at 20 % → 1.5 → 2), exactly as the cart and the checkout compute it.
- Stripe Tax: Stripe's per-line `amount_tax` is used as it is (already integer minor units; Stripe rounds per
  line); we never re-round. `taxRateBp` (persisted on cart/order lines) = Σ `tax_breakdown[].percentage_decimal`
  × 100 rounded to a basis point (US 8.875 % → 888 bp), or derived from the amounts when there is no breakdown.
  `FakeStripe` applies the same single rule, so fake results equal the table provider's.

## The table provider

Calls the cart's `tableTaxCalculator` for the rate of every line (category over store-wide, region over
country-wide, no row → 0 bp: an untaxed destination, not an error) — called, not reimplemented — then computes
the amount in the store's mode. Taxable shipping is priced at the goods' rate(s) — see "Delivery VAT" above; the
synthetic category-less line in the same lookup yields the store-wide rate used when no line carries a taxable
base. Seeded markets: EU/NL 21 %, UK/GB 20 %, US/NY 8.88 % (region `NY`; other states untaxed).

## The Stripe Tax provider

`POST /v1/tax/calculations` through the payments module's fetch client (`createTaxCalculation`, `expand[]=
line_items`) with `stripeCredentialsFor(store.code)` — `STRIPE_SECRET_KEY_<CODE>`, else `STRIPE_SECRET_KEY`
(ADR 0006; test mode only, live keys refused). Sent: currency, per-line amount (`quantity × unit − discount`),
our line id as `reference`, `tax_behavior` from the store's mode, the shipping price, and the destination
(`country`, `postal_code`, `state` = region, `city`). **Never sent or logged**: names, street lines, phone, email.
Lines with nothing to tax are not sent and come back as 0.

Failure modes:

- No Stripe key for a store whose settings say `stripe` → 400 `validation_error` naming the variables (fail closed).
- Stripe refuses the calculation (unlocatable address, unsupported currency) → 400 `validation_error` with
  Stripe's code. A decision, never a fallback case.
- **Outage (5xx / 429 / network) → FAIL CLOSED**: the error is rethrown, the cart mutation fails retryably; an
  order is never priced with a guessed tax. The only exception is the explicit opt-in
  `CORE_TAX_FALLBACK_TO_TABLE=1`, **non-production only**: production refuses the flag itself — a production
  environment that carries it (any value) refuses at registration/boot, same pattern as `CORE_DEV_TOKENS` and
  `CORE_STORE_API_FALLBACK`. With the opt-in, an outage prices with the table rates and logs one line (store id
  only).

## Window 1's side (REQUEST #221 — landed with core #224)

The cart and the checkout now show and freeze the calculator's per-line `taxMinor`, honour
`store.settings.tax.prices_include_tax` in the totals (tax is reported, never added on top of a gross price), and
pass `pricesIncludeTax` in the pricing context. `registerTaxProvider()` is mounted by window 1 (its #179 part 3
wiring PR). Order snapshots: the checkout freezes `tax_rate_bp` / `tax_minor` on order lines at placement.

## Tests

`tax.test.ts` (13; seeded throwaway database + FakeStripe): rounding (`taxFor` equals the cart's `taxOn` in both modes over a sweep, the half-cent tie), settings reader, the fallback flag incl. production refusal at registration, basis points;
table provider for EU / UK / US in both modes, delivery VAT (#352: EU default, the walk-through order, a mixed-rate cart pro rata, explicit exemption = the built-in's result, non-EU opt-in, checkout totals through the cart), region precedence, parity of the lines with the cart's
built-in calculator; Stripe provider request shape (no PII), mapping, inclusive behaviour + `state`, fail-closed
without a key, refusals, outage rethrow, opt-in fallback (one log line, refusals still fail); registered with
the cart end to end (default store priced as before, `stripe` store priced by the fake). `tax-live.test.ts`:
form encoding of the calculation; a real test-mode calculation — skips without `STRIPE_SECRET_KEY`.
