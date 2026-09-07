# @platform/admin

## Purpose

Next.js App Router admin application. One app, two views (Store view and HQ view) decided by the
principal's relations; every API call is re-checked server-side against the operation's
`x-permission`. Phase 1 reads permissions from `GET /admin/me` on the Prism mock — do **not** import
`@platform/auth-sdk` yet (window 2 is still writing it). Contract: Admin API 0.2.0.

## Owner

window 4 (admin). src/app/(hq)/bi/** is window 12 (embed only). src/app/(hq)/marketing/** and
src/app/(store)/[storeId]/marketing/** are window 17 from Phase 2 — placeholders only today; keep
them self-contained (no shared components inside them, no API calls until contracts-v0.3).

## Run / test

- `pnpm --filter @platform/admin dev` — http://localhost:3000 (port is fixed by the Keycloak
  client's registered redirect URI). Needs `pnpm mock` for the Admin API and `pnpm compose:up`
  for Keycloak.
- `pnpm --filter @platform/admin build` — `next build`
- `pnpm --filter @platform/admin typecheck`
- `pnpm --filter @platform/admin test` — Vitest (tests live in test/)
- `pnpm --filter @platform/admin test:contract` — suites in test-contract/ that boot Prism
  themselves; kept out of `pnpm test` so the unit suite stays fast and hermetic.
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/admin` before finishing any task.
- `pnpm --filter @platform/admin e2e` — Playwright, the store-admin journey (sign in → switch
  store → products). `e2e:ui` opens the runner.
  - Needs **Keycloak up** (`pnpm compose:up`): signing in is the point, so it uses the real staff
    realm. `playwright.config.ts` starts the Prism mock and a **production build** of the app itself
    (`next dev` differs enough around caching and server actions that a green dev run proves little).
  - **Must be on port 3000.** The `admin-app` client registers `http://localhost:3000/*` as its only
    redirect URI. If something else holds 3000, run the app elsewhere and set
    `ADMIN_APP_URL=http://localhost:3000` plus `E2E_BASE_URL`, so the `redirect_uri` still matches.
  - `channel: 'chrome'` uses the Chrome on the machine instead of downloading Playwright's browsers,
    matching window 3's storefront setup.
  - CI wiring is REQUEST #80 — `.github/workflows/**` is not this window's to edit.

## Public API

- Routes: `src/app/(store)/**` store-scoped screens, `src/app/(hq)/**` HQ-only screens
- Talks only to the Admin API (`@platform/contracts/admin`), in Phase 1 against `pnpm mock` (:4011)
- Add a screen: a typed wrapper in `src/lib/api/admin.ts`, then a server component. See README.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- `ADMIN_SESSION_SECRET` is required in every environment — there is no development fallback.
  Copy `.env.example` to `.env.local` and generate one with `openssl rand -base64 32`.
- Tokens stay on the server: `src/lib/api/admin.ts` is `server-only`; client components use server
  actions and route handlers. Never `fetch` the Admin API from the browser.
- `src/lib/api/admin-client.ts` and `src/lib/auth/{crypto,session,jwt}.ts` must stay free of
  `next/*` imports — they also run in the Edge middleware and in unit tests.
- A screen that cannot show what was asked for renders `ApiStatePanel`, never a blank page and
  never a thrown error. Every state panel needs a heading and a next action; `/states` (dev only)
  shows the whole set.
- Update README.md and CHANGELOG.md with every change.
