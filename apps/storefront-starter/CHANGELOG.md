# Changelog — @platform/storefront-starter

## 0.8.0 — 2026-09-07

Task [storefront] 1.8 (issue #62), contracts `0.2.0`. Closes Phase 1 for this window.

- Marketing attribution captured first-party in the middleware into an httpOnly cookie
  (`sf_attribution`, 30 days, SameSite=Lax): UTM parameters, `?ref=`, the referrer's **origin** and
  the landing path. First touch is never overwritten, last touch updates on a new campaign, and a
  visit with no marketing signal writes no cookie at all.
- Sent to our own Store API only, as `cart.metadata.attribution`, at `POST /store/carts` and again
  with `PATCH /store/carts/{id}` immediately before completing — `POST …/complete` has no request
  body, so the cart is the only place it can go. No third-party pixels.
- **`metadata` does not exist in contracts-v0.1** (the issue assumed it was free-form). The field is
  sent anyway, which the mock accepts, behind a one-line local type extension;
  **CONTRACT CHANGE #100** asks for it to be specified on `Cart`, `createCart`, `updateCart` and
  `Order`.
- Documented in the README under "Attribution" for window 17.
- Review nits from #97: `CLAUDE.md` had two `e2e` bullets, the older one describing the pre-#84
  browser behaviour; and the client-namespace test only recognised `'use client'` when it was the
  literal first characters of a file, so a directive after a comment was silently exempt.
- 20 new unit tests (157 in total).

## 0.7.0 — 2026-09-07

Task [storefront] 1.7 (issue #23) and REQUEST #84, contracts `0.2.0`. Config and docs only — infra
already landed the CI job that runs these journeys (#80/#87), so no workflow change is needed.

- `lighthouserc.json`: performance and accessibility ≥ 90, LCP ≤ 2.5 s, CLS ≤ 0.1, mobile emulation
  over PLP and PDP, median of three runs. `pnpm --filter @platform/storefront-starter lighthouse`.
- **Performance fix found by that budget.** PLP scored 89 and PDP 85, entirely on blocking time: the
  root layout handed `NextIntlClientProvider` the whole message catalogue, so every page serialised
  and hydrated strings it never used. It now passes only the namespaces the `'use client'` components
  need. PLP 89 → **96**, PDP 85 → **99**; PDP total blocking time 530 ms → 30 ms. A test keeps the
  namespace list in step with the components.
- **REQUEST #84:** the Playwright Chrome channel is conditional — the installed Chrome locally,
  Playwright's bundled chromium on CI (version-matched to the lockfile, lighter to install).
  `E2E_CHANNEL` overrides either way.
- The account journeys are now **required** when `$CI` is set instead of skipping: CI boots Keycloak,
  so an unreachable one is a real failure, and a silent skip would quietly stop covering sign-in.
- `CLAUDE.md` documents the e2e and Lighthouse commands; the README records the measured run and
  drops the stale pre-i18n numbers from task 1.3.

## 0.6.0 — 2026-09-07

Task [storefront] 1.6 (issue #22), contracts `0.2.0`.

Review fixes from PR #96: the currency switcher and the footer read the chosen currency from the
cookie rather than `store.default_currency` (they snapped back to the default on every render while
the cookie and cart stayed correct), and the cart is created in the **request** locale, so a
`/de-DE` shopper no longer gets an `en-GB` cart. `test/currency-roundtrip.test.ts` walks the whole
path — switcher → cookie → `POST /store/carts` — and was verified by reintroducing both bugs.

- Locale routing with **next-intl 4**: every page moves under `src/app/[locale]/`, `/` redirects to
  the default locale, and the choice is remembered in a cookie. Message catalogues for `en-GB` and
  `de-DE`; supported locales are build config (`SUPPORTED_LOCALES`) validated at render against
  `store.locales` — a locale the store does not offer is a 404, not a half-translated page.
- `hreflang` alternates and a per-locale canonical.
- Money and dates format in the **request** locale, not the store default: `/de-DE` prices read
  `19,99 €` where `/en-GB` reads `€19.99`.
- Currency selection limited to `store.currencies`, kept in a cookie and validated before use;
  `POST /store/carts` is created in the chosen currency. Language and currency switchers in the
  shop header, both server-rendered and JavaScript-free.
- The route handlers (`/health`, `/auth/{sign-in,callback,sign-out}`) deliberately stay outside the
  locale tree: the probe must not redirect and the OIDC callback URL is registered with Keycloak.
  In-app redirects go through `redirectLocalized` so they keep the prefix.
- Tests: catalogue parity, placeholder parity, an untranslated-copy check, currency resolution,
  a **key-existence check** (next-intl only logs `MISSING_MESSAGE`, so a typo would otherwise ship
  as visible rubbish), and the no-hard-coded-strings check the acceptance criteria ask for.
  35 new unit tests (124 in total) plus two Playwright specs for the German page and the alternates.

## 0.5.0 — 2026-09-06

Task [storefront] 1.5 (issue #21) and REQUEST #68, contracts `0.2.0`.

- Sign-in against the Keycloak **customers** realm: OIDC authorization code + PKCE (S256) with the
  public client `storefront-brand-a`. Route handlers `/account/sign-in`, `/account/callback` and
  `/account/sign-out`; tokens live in an httpOnly cookie and never reach the page.
- `/account`: profile (`GET`/`PATCH /store/customers/me`) and addresses
  (`GET`/`POST …/me/addresses`). `/account/orders`: order history from `GET …/me/orders` with
  `Price` and an empty state. Unauthenticated access redirects to sign-in and back to the page that
  was asked for; `returnTo` is restricted to same-site paths.
- The customer token is attached only to `/store/customers/*` and `/store/orders/{id}` — enforced by
  the API client, which throws rather than sending it anywhere else.
- Playwright: sign-in as the seeded Jane, order history renders order `#1000`, sign-out ends the
  Keycloak SSO session. The account specs run serially because they share one Keycloak user.
- **REQUEST #68 (window 5):** `next.config.ts` → `next.config.mjs`, so the production image (built
  with `--prod`, without `typescript`) can load it; `start` honours `$PORT` (defaulting to 3100, not
  Next's 3000, which collides with the admin app) through `scripts/start.mjs` — a wrapper because
  `--port ${PORT:-3100}` does not expand on Windows; new `GET /health` route, required by the image
  contract in `infra/README.md` now that this package has a `start` script.
- 16 new unit tests (89 in total).

## 0.4.0 — 2026-09-05

Task [storefront] 1.4 (issue #20), contracts `0.2.0`.

- Cart at `/cart`: line items, quantity update and remove. The cart lives in the API; the browser
  only carries its id in an httpOnly cookie.
- Checkout steps `/checkout/{address,shipping,payment,review}`, with `/checkout` routing to whatever
  the cart still needs, and an order confirmation at `/orders/[orderId]`.
- Every mutation is a server action using the typed client (`src/lib/actions.ts`): add to cart,
  update/remove line item, save address, choose delivery, create the payment session, place the
  order. The browser never calls the Store API.
- `Idempotency-Key` generated once per cart and reused on every retry, stored as `<cartId>:<key>` so
  a stale cookie can never attach an old key to a new order.
- Error mapping (`mapCheckoutError`): `409 out_of_stock` offers the quantity actually left (read
  from the contract's `details.available`),
  `402 payment_failed` returns to the payment step, `409 cart_completed` forwards to the order that
  already exists.
- Payment is the `manual` provider placeholder; no card data touches the app. Hosted fields arrive
  with window 7.
- Playwright: PLP → PDP → cart → checkout → confirmation against `pnpm mock`, plus step-skipping and
  URL-filter checks. `pnpm --filter @platform/storefront-starter e2e`.
- 23 new unit tests (72 in total).

## 0.3.0 — 2026-09-05

Task [storefront] 1.3 (issue #19), contracts `0.2.0`.

- PLP at `/products` (search, category filter, sort, pagination) and `/categories/[handle]`, sharing
  one `ProductListView`. Filters, sort and paging are links and a GET form — no client component,
  every view has a shareable URL, and the first render needs no JavaScript.
- PDP at `/products/[handle]`: gallery via `next/image`, breadcrumb, description, tags, and a
  `VariantPicker` (the page's only client component) that resolves `product.options` against
  `variants[].options`, disables unreachable combinations, and shows price with `compare_at_price`
  struck through plus in-stock / low-stock / backorder / out-of-stock state.
- `src/lib/catalog.ts` — tagged, deduped catalog reads (`products`, `categories`,
  `product:<handle>`, 60 s revalidate), query-string parsing narrowed to the contract's values, and
  canonical link building. `src/lib/variant.ts` — the pure option → variant resolver.
- Caching: `force-dynamic` moved off the root layout onto the pages that have no cacheable data of
  their own, so PLP and PDP now use the fetch cache while `next build` still needs no API.
- `metadataBase` so the API's relative `seo.canonical` resolves to an absolute URL; descriptions on
  the listing pages.
- Lighthouse (mobile, production build, against `pnpm mock`): **PLP performance 99–100, PDP 100**;
  LCP 1.5–2.0 s, CLS 0, accessibility 100.
- 34 new tests (50 in total).

## 0.2.0 — 2026-09-04

Task [storefront] 1.2 (issue #18), contracts `contracts-v0.1`. Replaces the Phase 0 scaffold with the
real Next.js App Router app.

- Next 15 App Router on port 3100, React 19, Tailwind 3 driven by the `@platform/ui` preset.
- Route groups `(shop)` (`/`, `/products`), `(checkout)` (`/cart`, `/checkout`, own funnel chrome),
  `(account)` (`/account`), `(content)` (`/pages/[slug]`, placeholder for window 6), plus `not-found`.
- Root layout resolves the theme — `store.theme` from the API layered under `src/brand/tokens.ts` —
  and renders `<body>` through `ThemeProvider`.
- Typed Store API client in `src/lib/store-api/`: every operation of the Store API, `X-Publishable-Key`
  on every request, `Idempotency-Key` support, cache tags, `StoreApiError` with the contract's error
  codes, and a path allowlist so a customer token can only reach `/store/customers/*` and
  `/store/orders/{id}`. Server-only.
- Brand override pattern: `src/brand/{tokens.ts,components/,layouts/}` plus slot registries in
  `src/lib/slots.ts`, documented in the README.
- 16 Vitest tests (client URL/header/error/token behaviour, slot resolution).
- Phase 1 renders every route per request; task 1.3 introduces per-route caching.

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
