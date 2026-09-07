# @platform/storefront-starter

## Purpose

Next.js App Router storefront template. Brand storefronts in apps/storefronts/<brand> are generated
from it (ADR 0004) and override theme tokens, slots and route files.

## Owner

window 3 (storefront). (content) and src/lib/cms are window 6; (account) is window 13.

## Run / test

- `pnpm mock` — Prism Store API on :4010 (required for real data)
- `pnpm --filter @platform/storefront-starter dev` — storefront on **:3100**
- `pnpm --filter @platform/storefront-starter build` — `next build`
- `pnpm --filter @platform/storefront-starter typecheck`
- `pnpm --filter @platform/storefront-starter test` — Vitest (tests live in test/)
- `pnpm --filter @platform/storefront-starter e2e` — Playwright (specs in `e2e/`); boots the Prism
  mock and a production build itself, headless, non-zero exit on failure. `e2e:ui` for the
  interactive runner. Uses the locally installed Chrome; on CI, Playwright's bundled chromium
  (REQUEST #84) — `E2E_CHANNEL` overrides either way. The account journeys need Keycloak
  (`docker compose -f infra/docker/docker-compose.yml up -d keycloak`): they skip locally without it
  and are **required** when `$CI` is set.
- `pnpm --filter @platform/storefront-starter lighthouse` — Lighthouse CI against `lighthouserc.json`
  (mobile, 3 runs, median). Needs a running app on :3100 and `CHROME_PATH` on Windows. Budgets:
  performance and accessibility ≥ 90, LCP ≤ 2.5 s, CLS ≤ 0.1.
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/storefront-starter` before finishing any task.

## Public API

- Talks only to the Store API (`@platform/contracts/store`), in Phase 1 against `pnpm mock` (:4010)
- Sends `X-Publishable-Key` on every request (the API resolves store and sales channel from it and
  refuses requests without it). `Idempotency-Key` on `POST …/complete`; the customer's bearer token
  only on `/store/customers/*` and `/store/orders/{id}`.
- Route groups: (shop), (checkout), (account) (window 13), (content) (window 6)

## Layout

- `src/lib/store-api/` — the typed client; **the only** module that knows the base URL, the key and
  the header names. Types (`Result`, `Query`, `Body`) derive from the contract, so a contract change
  is a compile error, not a runtime surprise. Server-only: it throws if constructed in the browser.
- `src/lib/slots.ts` — slot registries; pages ask `getLayouts()` / `getComponents()` instead of
  importing chrome directly.
- `src/lib/catalog.ts` — tagged catalog reads and listing query parsing; `src/lib/variant.ts` — the
  pure option → variant resolver.
- `src/lib/auth/` — OIDC PKCE against the Keycloak customers realm, and the session cookie.
  `src/lib/account-actions.ts` — profile and address mutations.
- `src/lib/actions.ts` — every mutation, as server actions. `src/lib/checkout.ts` holds the pure
  checkout rules (step order, address parsing, error mapping); `src/lib/cart.ts` and
  `src/lib/idempotency.ts` own the cookies.
- `src/brand/{tokens.ts,components/,layouts/}` — the only folder a brand app edits routinely.
- `src/app/` — route groups; the root layout resolves the theme and renders `<body>` through
  `ThemeProvider`.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- No business logic here: pricing, stock, tax and promotions come from the core (ADR 0004).
- Card data never touches the app — hosted fields only (window 7 in Phase 2).
- Customer tokens live in an httpOnly cookie and go only to `/store/customers/*` and `/store/orders/{id}`.
- `start` must honour `$PORT` and `GET /health` must answer 200 (image contract, infra/README.md).
- Update README.md and CHANGELOG.md with every change.
