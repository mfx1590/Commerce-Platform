# @platform/storefront-brand-d

Brand D's storefront — **Japan, JPY, `ja-JP` only**, port **3104**. Generated from
`apps/storefront-starter` through `apps/storefronts/brand-b/scripts/new-brand.mjs` (ADR 0004) on
2026-11-12, as the **D8 brand-onboarding proving run**: the first brand whose store was created in
the admin onboarding wizard rather than seeded.

> **"Brand D" is a placeholder name.** It came off the generator's command line, not from the
> business. LAUNCH row 0.1 — the owner names the brand — is open, and so is every sentence of
> content and all four legal documents.

## Identity

|                 |                                                                              |
| --------------- | ---------------------------------------------------------------------------- |
| Port            | **3104** (`scripts/start.mjs`, `playwright.config.ts`, `package.json` `dev`) |
| Market          | **JP**, ships JP only                                                        |
| Currency        | **JPY — zero-decimal.** ¥1,980 is `1980` minor units, not 198000             |
| Locale          | **`ja-JP` only** (`SUPPORTED_LOCALES` in `next.config.mjs`)                  |
| Store code      | `brand-d` — created by the wizard, **not in `packages/db`'s seed**           |
| Keycloak client | `storefront-brand-d`                                                         |

## Running it against a core

The store is not seeded, so this brand needs **four** environment values, and each one fails
separately and only once the previous is satisfied (#828):

```bash
STORE_API_URL=http://localhost:9000 \
STORE_PUBLISHABLE_KEY=<from the onboarding wizard — never commit it> \
SITE_URL=http://localhost:3104 \
KEYCLOAK_URL=http://localhost:8180 \
PORT=3104 pnpm --filter @platform/storefront-brand-d start
```

- `STORE_PUBLISHABLE_KEY` **must** come from the environment. `next.config.mjs` carries
  `pk_brand-d_dev_…`, which is the seeded-database form and authenticates as nothing against a real
  core; the wizard's key is real, one-time, and must never be committed (#827).
- `SITE_URL` must be a loopback origin locally: a build made by `scripts/e2e-server.mjs` has
  `E2E_LOCAL_IMAGES` **inlined**, and the app refuses to start with it outside loopback.
- `KEYCLOAK_URL` is required since #783 — the CSP `form-action` needs its origin.
- `pnpm --filter … start`, not `node scripts/start.mjs`: the latter has no workspace bin path.

`pnpm --filter @platform/storefront-brand-d e2e` supplies `SITE_URL` and `KEYCLOAK_URL` itself;
point it at a core with `E2E_STORE_API_URL`.

## Zero-decimal money

This is the first brand in a currency with **no minor unit**. Nothing in the storefront assumes two
decimals: `packages/ui`'s `minorUnitDigits` asks CLDR, which answers 0 for JPY, 2 for USD/EUR/GBP and
3 for BHD. Measured on the generated app against the real store: the Store API returns
`{ amount_minor: 1980, currency: "JPY" }` and the PDP renders **￥1,980**, with no decimal yen
anywhere on the page.

## Bundle budget

First-load JavaScript per route, gzipped, against the thresholds in `bundle-budget.json`. The table
is written by `node scripts/bundle-budget.mjs --sync-readme` after a build — do not edit it by hand.
The figures below come from this brand's first CI perf leg; the check compares routes and budgets
rather than sizes, so a figure that has moved by a few bytes is not a failure, but a missing route
or a changed budget is.

<!-- bundle-budget:start -->

| Route                                         | First load (gzipped) | Budget             |
| --------------------------------------------- | -------------------- | ------------------ |
| `/[locale]/(account)/account/deleted/page`    | 131.4 kB             | 145 kB _(default)_ |
| `/[locale]/(account)/account/orders/page`     | 131.4 kB             | 145 kB _(default)_ |
| `/[locale]/(account)/account/page`            | 136.8 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/cart/page`              | 141.9 kB             | 145 kB             |
| `/[locale]/(checkout)/checkout/address/page`  | 134.6 kB             | 139 kB             |
| `/[locale]/(checkout)/checkout/page`          | 130.2 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/checkout/payment/page`  | 134.6 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/checkout/review/page`   | 135.7 kB             | 139 kB             |
| `/[locale]/(checkout)/checkout/shipping/page` | 134.6 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/orders/[orderId]/page`  | 131.4 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/campaign/[slug]/page`    | 133.7 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/legal/[slug]/page`       | 133.7 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/pages/[slug]/page`       | 133.7 kB             | 145 kB _(default)_ |
| `/[locale]/(shop)/categories/[handle]/page`   | 137.1 kB             | 141 kB             |
| `/[locale]/(shop)/page`                       | 132 kB               | 136 kB             |
| `/[locale]/(shop)/products/[handle]/page`     | 141.4 kB             | 144 kB             |
| `/[locale]/(shop)/products/page`              | 137.1 kB             | 141 kB             |
| `/[locale]/[...rest]/page`                    | 125.1 kB             | 145 kB _(default)_ |
| `/_not-found/page`                            | 103.3 kB             | 145 kB _(default)_ |

_Generated by `pnpm --filter @platform/storefront-starter bundle-budget --sync-readme`; budgets live in `bundle-budget.json`._
<!-- bundle-budget:end -->

## What is NOT finished

|                          |                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| the brand name           | a placeholder (LAUNCH 0.1)                                                                            |
| theme tokens             | the design-kit default, not a brand                                                                   |
| all content prose        | generated placeholders in `cms/brand-d/content`                                                       |
| the four legal documents | **JP is not a known jurisdiction** to the generator: structure only, written by a lawyer from scratch |
| `messages/ja-JP.json`    | **untranslated** — a copy of `en-GB`, so the app renders; every string is English                     |
| the media manifest       | no `bytes`/`sha256`: the brand's stills do not exist                                                  |
| LAUNCH.md                | not written yet                                                                                       |

## Diff against the starter

Everything outside the identity files is byte-identical to `apps/storefront-starter` and is
refreshed with `pnpm --filter @platform/storefront-brand-d sync`; `sync --check` reports drift in
the preserved files. The identity files are `next.config.mjs`, `playwright.config.ts`,
`scripts/start.mjs`, `tsconfig.json`, `tailwind.config.ts`, `bundle-budget.json`,
`lighthouserc.json`, `package.json`, `test/launch-gate.test.ts` and everything under `src/brand/`.

Two of those were wrong when generated and are fixed here by hand, both in `playwright.config.ts`:
`SUPPORTED_LOCALES` was the template brand's `en-GB` (#826 — it killed the whole e2e suite in
warm-up) and `E2E_SHIP_ADDRESS_JSON` was a Manchester address against a store that ships JP only.
