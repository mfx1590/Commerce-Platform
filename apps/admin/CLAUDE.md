# @platform/admin

## Purpose

Next.js App Router admin application. One app, two views (Store view and HQ view) decided by the
principal's relations; every API call is re-checked server-side against the operation's
`x-permission`. Phase 1 reads permissions from `GET /admin/me` on the Prism mock — do **not** import
`@platform/auth-sdk` yet (window 2 is still writing it).

## Owner

window 4 (admin). src/app/(hq)/bi/** is window 12 (embed only).

## Run / test

- `pnpm --filter @platform/admin dev` — http://localhost:3000 (port is fixed by the Keycloak
  client's registered redirect URI). Needs `pnpm mock` for the Admin API and `pnpm compose:up`
  for Keycloak.
- `pnpm --filter @platform/admin build` — `next build`
- `pnpm --filter @platform/admin typecheck`
- `pnpm --filter @platform/admin test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/admin` before finishing any task.
- Delete `.next/` before `pnpm format:check`: Prettier's root ignore list does not exclude Next
  build output yet.
- Playwright (from issue #30 onward): scripted against `pnpm mock`; CI wiring is requested from
  window 5 via a `REQUEST:` issue, because `.github/workflows/**` is not owned by this window.

## Public API

- Routes: `src/app/(store)/**` store-scoped screens, `src/app/(hq)/**` HQ-only screens
- Talks only to the Admin API (`@platform/contracts/admin`), in Phase 1 against `pnpm mock` (:4011)
- Add a screen: a typed wrapper in `src/lib/api/admin.ts`, then a server component. See README.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Tokens stay on the server: `src/lib/api/admin.ts` is `server-only`; client components use server
  actions and route handlers. Never `fetch` the Admin API from the browser.
- `src/lib/api/admin-client.ts` and `src/lib/auth/{crypto,session,jwt}.ts` must stay free of
  `next/*` imports — they also run in the Edge middleware and in unit tests.
- Update README.md and CHANGELOG.md with every change.
