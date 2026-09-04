# @platform/admin

Next.js App Router admin application. One app, two views — **HQ** and **Store** — decided by the
relations the signed-in principal holds. Everything the UI shows is derived from `GET /admin/me`;
the Admin API re-checks each operation's `x-permission` server-side, so UI gating is convenience,
never security.

Contracts: `@platform/contracts/admin`, frozen at tag **contracts-v0.1**.

## Run it

```bash
pnpm mock                            # Prism Admin API mock on :4011 (repo root)
pnpm compose:up                      # Postgres, Redis, Keycloak (:8180), OpenFGA, Redpanda
pnpm --filter @platform/admin dev    # http://localhost:3000
```

No `.env` is required — every setting has a default matching the repo-root `.env.example`. Copy
[`.env.example`](./.env.example) to `.env.local` only to point somewhere else.

| Variable               | Default                 | Meaning                                             |
| ---------------------- | ----------------------- | --------------------------------------------------- |
| `KEYCLOAK_URL`         | `http://localhost:8180` | Keycloak base URL                                   |
| `KEYCLOAK_REALM_STAFF` | `staff`                 | Staff realm (customers live in another one)         |
| `ADMIN_OIDC_CLIENT_ID` | `admin-app`             | Public PKCE client                                  |
| `ADMIN_APP_URL`        | `http://localhost:3000` | Origin used to build the redirect URI               |
| `MOCK_ADMIN_API_URL`   | `http://localhost:4011` | Admin API base URL                                  |
| `ADMIN_SESSION_SECRET` | dev constant            | Encrypts the session cookie; required in production |

Port 3000 is fixed: the Keycloak client registers `http://localhost:3000/*` as its only redirect URI.

## Checks

```bash
pnpm --filter @platform/admin test       # Vitest
pnpm --filter @platform/admin typecheck  # tsc --noEmit
pnpm --filter @platform/admin build      # next build
```

From the repo root, `pnpm lint && pnpm typecheck && pnpm test --filter @platform/admin` before
finishing a task. Run `pnpm --filter @platform/admin clean` (or delete `.next/`) before
`pnpm format:check`: Prettier's ignore file does not yet exclude Next build output.

## How the auth hook works

Authorization code + PKCE against the Keycloak staff realm. The client is **public** — there is no
client secret anywhere in this app; the code verifier is what binds the callback to the browser
that started sign-in.

1. `src/middleware.ts` gates every page. No session → redirect to `/api/auth/login?returnTo=…`.
2. [`/api/auth/login`](./src/app/api/auth/login/route.ts) generates `state` and a code verifier,
   parks both in short-lived httpOnly cookies and redirects to Keycloak's authorization endpoint
   with `code_challenge_method=S256`.
3. [`/api/auth/callback`](./src/app/api/auth/callback/route.ts) checks `state`, redeems the code
   with the verifier, and seals the token set into the session cookie.
4. [`/api/auth/logout`](./src/app/api/auth/logout/route.ts) clears the cookies and ends the realm
   SSO session, so the next sign-in really asks for credentials.

**Where the tokens live.** The whole token set is AES-GCM encrypted with `ADMIN_SESSION_SECRET` and
stored in an httpOnly, `SameSite=Lax` cookie (`secure` in production). Keycloak tokens exceed the
4 KB per-cookie limit, so the sealed value is split across `admin_session.0`, `admin_session.1`, …
and rejoined on read; a shrinking session clears its stale tail. A cookie that does not decrypt is
simply treated as signed out.

**Where the tokens do not go.** No client component ever receives one. `src/lib/api/admin.ts` is
`import 'server-only'`, so importing it from a `'use client'` file is a build error rather than a
leak. Client components reach the API through server actions and route handlers.

**Refresh.** Only the middleware can still write cookies for the current request, so it is the one
place that refreshes: within 60 s of expiry it redeems the refresh token, updates both the incoming
request and the response, and a failed refresh starts a clean sign-in rather than rendering with a
token the API would reject.

## Two views, one app

Which sections exist is fixed; which of them _you_ see is a pure function of the `Principal` from
`GET /admin/me`. That function lives in [`src/lib/nav/`](./src/lib/nav/) and imports nothing from
`next/*`, so it is unit-tested directly against fixtures for all seven seeded roles.

| View                  | Sections                                                  | Gated on                               |
| --------------------- | --------------------------------------------------------- | -------------------------------------- |
| **HQ** (`(hq)`)       | Stores, Warehouse, Finance, BI, Roles, Onboarding         | relations on `organization:hq`         |
| **Store** (`(store)`) | Catalog, Orders, Customers, Promotions, Content, Settings | relations on the selected `store:{id}` |

`src/lib/nav/sections.ts` is the catalogue, and every entry carries a `why` naming the contract
operation its gate comes from — `Settings` requires `store_admin` because `updateStore` does.
`src/lib/nav/relations.ts` mirrors the OpenFGA model in ADR 0002, so implication works: an
organization `owner` is a store admin everywhere, `store_admin` implies `store_staff`, and any
organization relation makes you a store `viewer`. Finance is organization-only by construction — no
number of stores adds up to it.

**Three gates, not one.** Hiding a nav entry is the weakest of them:

1. the nav does not render the link;
2. the page's `HqSectionGuard` / `StoreSectionGuard` renders a 403 panel if you type the URL anyway,
   and the store layout re-validates the store id against `stores[]` on _every_ request;
3. the Admin API re-checks the operation's `x-permission`. This is the only one that is security.

**The store switcher** lists exactly `stores[]` — nothing inferred. The choice is remembered in the
`admin_selected_store` cookie, but the cookie is only a hint: it is re-validated on every request,
so revoking someone's access to a store takes effect on their next page load rather than at cookie
expiry. Switching keeps you on the same section (Orders on brand-a → Orders on brand-b).

**Adding a section** means one entry in `src/lib/nav/sections.ts` (with its `why`), a folder under
`src/app/(hq)/` or `src/app/(store)/[storeId]/`, and a row in the test matrix in
`test/navigation.test.ts`. Nothing else knows the list.

## How to add a screen

1. **Add a typed call** in [`src/lib/api/admin.ts`](./src/lib/api/admin.ts):

   ```ts
   export async function listStores(page = 1) {
     return adminCall<'listStores'>({ path: '/admin/stores', query: { page, limit: 20 } });
   }
   ```

   The type parameter is the contract `operationId`; `AdminResponse<'listStores'>` is then the exact
   success body from `admin-api.yaml`. For templated paths use
   `buildPath('/admin/stores/{storeId}/products', { storeId })`.

2. **Render it in a server component.** Calls never throw on an HTTP error — they resolve to
   `{ ok: true, data }` or `{ ok: false, status, error }`, so a `403` renders a panel in place
   instead of taking down the route:

   ```tsx
   const result = await listStores();
   if (!result.ok) return <ErrorPanel status={result.status} error={result.error} />;
   ```

   Check the operation's `x-permission` in `admin-api.yaml` to decide which relation should reveal
   the entry point in the navigation.

3. **Keep mutations on the server.** Submit through a server action that calls `adminCall`; never
   `fetch` the Admin API from the browser.

## Layout

| Path                     | What lives there                                                     |
| ------------------------ | -------------------------------------------------------------------- |
| `src/app/(hq)/`          | HQ routes (`/stores`, `/finance`, …)                                 |
| `src/app/(store)/`       | Store routes (`/{storeId}/catalog`, …)                               |
| `src/app/api/auth/`      | The OIDC endpoints                                                   |
| `src/app/actions/`       | Server actions (the store switcher's submit handler)                 |
| `src/middleware.ts`      | The auth gate and the only place that refreshes tokens               |
| `src/lib/env.ts`         | Server-side configuration and defaults                               |
| `src/lib/auth/`          | PKCE, discovery, token exchange, session sealing                     |
| `src/lib/api/`           | Admin API transport (`admin-client.ts`) and typed calls (`admin.ts`) |
| `src/lib/nav/`           | Sections, the relation algebra, and the selected-store cookie        |
| `src/components/shell/`  | The frame: header, side nav, store switcher, section guards          |
| `src/components/states/` | The 403 / no-access / error panels                                   |
| `src/components/ui/`     | Presentational primitives (`cn`, Button, Card, Badge)                |
| `test/`                  | Vitest suites; `test/fixtures/principals.ts` holds the role fixtures |

`src/lib/api/admin-client.ts`, `src/lib/auth/session.ts` and everything in `src/lib/nav/` except
`selected-store.ts` avoid `next/*` imports on purpose, so they run unchanged in the Node runtime,
the Edge middleware, and unit tests.

Owner: window 4 (admin). `src/app/(hq)/bi/**` is window 12 (embed only). See CLAUDE.md.
