# Changelog — tax module (window 7)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — payments/phase2 (contracts-v0.4.1)

#### 2026-09-19 · review fix on #227 — one rounding seam

- `table-provider.ts`: `inclusiveTaxOn` deleted; `taxFor` is the cart module's `taxOn(amount, bp, included)` (core
  #224: the TAX rounds half-up in both modes). The old rule rounded the NET and differed at half-cent ties
  (gross 9 at 2000 bp: 1 vs the platform's 2). `FakeStripe.createTaxCalculation`, the tests (tie case, sweep
  against `taxOn`) and the README "Rounding" section follow the same single rule.

### 2026-09-19 · 2.4 Tax adapter: table rates + Stripe Tax behind the cart's TaxCalculator (#127)

- `types.ts`: `TaxProvider`, `TaxSettings` (`store.settings.tax`: `provider`, `prices_include_tax`,
  `shipping_taxable`), `taxSettingsFrom` (malformed → defaults, never throws).
- `table-provider.ts`: the cart's `tableTaxCalculator` for the rates (called, not reimplemented), tax-inclusive
  extraction (through the cart's `taxOn(…, included)` since the #227 review fix), taxable shipping via a synthetic line.
- `stripe-provider.ts`: Stripe Tax through the payments module's `createTaxCalculation`; amounts, ids and the
  destination only; Stripe's per-line integers used as they are; `rateBpOf`.
- `provider.ts`: `createTaxCalculator` — reads the store's settings per pricing pass and dispatches; Stripe
  outages fail closed; `CORE_TAX_FALLBACK_TO_TABLE=1` is a non-production opt-in, refused in production at
  registration.
- `index.ts`: `registerTaxProvider()` (boot mount point, REQUEST #221).
- payments module: `StripeApi.createTaxCalculation` on `StripeClient` and `FakeStripe` (`taxRateBp`,
  `outageNextTax`, `failNextTax`), `StripeTaxCalculation` / `StripeTaxLineItem` types.
- REQUEST #221 to window 1: per-line tax from the calculator, totals honouring `prices_include_tax`, mount line.
- Tests: `tax.test.ts` (13), `tax-live.test.ts` (skips without `STRIPE_SECRET_KEY`). README with the rounding
  rules and failure modes.
