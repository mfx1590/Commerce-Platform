# Changelog — @platform/storefront-starter

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
- Error mapping (`mapCheckoutError`): `409 out_of_stock` offers the quantity actually left,
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
