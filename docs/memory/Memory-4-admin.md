# Memory 4 — Admin application
Window: 4 · Key: `admin` · Branch prefix: `admin/` · Model: Opus (Memory-main, owner decision 2026-09-04)
Last updated: 2026-09-04 · Contracts: contracts-v0.1 · Last commit: ddec363 · Status: task 1.1 done (PR #42 open), 1.2 next

## Identity (does not change)
Owned paths (write):
- `apps/admin/**`
Reads:
- packages/contracts
- packages/auth-sdk
Never touches:
- apps/core internals
- packages/*

## Mission — Phase 1 (Isolated modules)
Single admin app with two permission-driven views. Shell: layout, nav rendering only allowed sections (HQ: Stores, Warehouse, Finance, BI, Roles, Onboarding; Store: Catalog, Orders, Customers, Promotions, Content, Settings), store switcher limited to allowedStores(user), auth hook, data-table and form primitives, working registry + catalog screens against the mock Admin API. Every screen handles 403 gracefully.

## Done
- **1.1 — issue #24 App skeleton, auth hook (Keycloak OIDC), session** · commit `ddec363`
  - `apps/admin` is now a Next.js 15 App Router app (React 19, Tailwind v4, TanStack Query),
    replacing the Phase 0 library scaffold. `src/index.ts`, `main`, `exports` removed.
  - OIDC authorization-code + PKCE S256 against the staff realm, public client `admin-app`:
    `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`; `src/middleware.ts` gates every
    page and is the only place that refreshes the access token.
  - Session = the whole token set, AES-GCM sealed into an httpOnly SameSite=Lax cookie, chunked
    across `admin_session.N`. `src/lib/api/admin.ts` is `server-only`, so no token can reach a
    client component.
  - Typed Admin API transport over `@platform/contracts/admin`; `AdminResponse<'operationId'>`
    yields the exact contract body, and every call resolves to `{ok:true,data}|{ok:false,status,error}`.
  - `/` renders the `Principal` from `GET /admin/me`. 23 Vitest tests. README rewritten (how to run,
    how the auth hook works, how to add a screen), CHANGELOG + package CLAUDE.md updated.
  - Verified: `pnpm lint`, `pnpm format:check`, `pnpm typecheck` (13/13), `next build`, 23 tests green.
    OIDC config verified headlessly end to end (discovery → PKCE → login form → code → token
    exchange → `GET /admin/me` with the real access token); the browser round-trip is blocked, see
    Blocked / waiting.

## In progress
- Nothing. Task 1.2 (issue #25, permission-driven navigation + store switcher) is next; it needs no
  new dependencies and can start against the mock immediately.

## Next — Phase 1
- [x] 1.1 App skeleton, auth hook (Keycloak OIDC), session — #24, PR #42 (do not self-merge)
- [ ] 1.2 Permission-driven navigation + store switcher — #25
- [ ] 1.3 Data-table primitive (TanStack Table): sort, filter, paginate, bulk — #26
- [ ] 1.4 Form primitive (RHF + Zod) with server-error mapping — #27
- [ ] 1.5 Stores screen (HQ) and Catalog screens (Store view) against mock — #28
- [ ] 1.6 403 / empty / error states pattern — #29
- [ ] 1.7 Tests: nav renders per role fixture — #30

## Decisions made (with reasons)
- **Session in an encrypted cookie, not a server store.** Phase 1 has no session backend and the
  admin app must stay stateless for preview deploys. AES-GCM over the token set with
  `ADMIN_SESSION_SECRET`; a cookie that will not decrypt is simply "signed out". Revisit in Phase 2
  if token size or revocation latency becomes a problem.
- **Cookies are chunked (`admin_session.0…N`).** Keycloak access+refresh+id tokens are ~4–6 KB
  sealed, over the 4096-byte per-cookie browser limit. Writing N chunks and deleting the tail
  prevents a shrinking session from being corrupted by a stale chunk.
- **Refresh happens in the middleware, nowhere else.** A server component may read cookies but not
  write them, so refreshing anywhere else would silently drop the new token. The middleware updates
  the incoming request too, so the current render already sees it.
- **Dropped `jose`.** Its JWE path pulls `CompressionStream` into the Edge bundle (`next build`
  warned). The only need was decoding ID-token claims → `src/lib/auth/jwt.ts`, ~30 lines. Decoding
  without signature verification is correct here: the token came over TLS straight from the token
  endpoint, and the Admin API verifies *access* tokens against the realm JWKS.
- **shadcn/ui primitives written by hand.** The CLI writes outside `apps/admin/**` (root config) and
  wants network access at generate time. `cn()` + Button/Card/Badge cover Phase 1; the data-table
  and form primitives arrive with #26/#27.
- **Own tsconfig, not `tsconfig.base.json`.** Next needs `moduleResolution: Bundler` and
  `jsx: preserve`; the base config is `NodeNext`. `strict`, `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` are kept identical.
- **`typecheck` is plain `tsc --noEmit`, not `next build`.** CI runs lint → format → typecheck with
  no build step, so typecheck must pass without generated `.next/types`.

## Blocked / waiting
- **#24 acceptance criterion 1 (browser sign-in round-trip) — two environment blockers, both
  outside `apps/admin/**`.** The code is complete and the OIDC flow is verified headlessly.
  1. **Port 3000 is taken by an unrelated project** (`Propertymate` Next dev server, PID varies).
     Port 3000 is not negotiable: the `admin-app` client registers `http://localhost:3000/*` as its
     only redirect URI and `http://localhost:3000` as its only web origin.
  2. **The `staff` realm forces TOTP enrolment.** Its browser flow is `browser-mfa` with
     *OTP Form = REQUIRED*, so `store-admin` is redirected to
     `login-actions/required-action?execution=CONFIGURE_TOTP` after the password step and never
     reaches the callback. This is not in the repo: `infra/keycloak/staff-realm.json` has no
     `browserFlow` or `authenticationFlows` key at all, so the flow was configured out-of-band and
     now persists in the `keycloak-data` volume (which no longer re-imports on restart). Filed as
     **REQUEST #43** for window 2 — `infra/keycloak/**` is theirs. It offers three fixes: plain
     browser flow, conditional OTP, or seeded TOTP credentials. #30 (Playwright store-admin journey)
     needs whichever lands.
- **REQUEST #44** — root `eslint.config.mjs` and `.prettierignore` do not cover Next build output
  (`next-env.d.ts`, `.next/`). CI is unaffected; local `pnpm format:check` needs `.next/` deleted
  first. Window 3 will hit the same thing.

## Gotchas learned
- Keycloak's realms now live in a persistent volume (manager, commit bbb6259). If it 500s it is
  restarting: wait 20 s, then `docker compose -f infra/docker/docker-compose.yml restart keycloak`.
  Restarting a shared dev service is allowed for every window.
- **Nothing in the repo pins the staff realm's authentication flow.** `staff-realm.json` only
  carries realm attributes, `clients` and `users`; the running realm's `browserFlow` is `browser-mfa`
  with a REQUIRED OTP Form. Since Keycloak switched to a persistent volume, `--import-realm` no
  longer overwrites it, so restarting will *not* clear this.
- **Root ESLint and Prettier do not know about Next.js build output.** `eslint .` fails on the
  generated `apps/admin/next-env.d.ts` (`triple-slash-reference`) and `prettier --check .` walks
  `apps/admin/.next/`. Both are ignored in `apps/admin/.gitignore`, and CI is unaffected (it never
  builds before linting), but delete `.next/` before running `pnpm format:check` locally.
- **jsdom 30 is broken on Node 20.19** (`webidl.util.markAsUncloneable is not a function` via
  undici 8). Pinned to `jsdom@^26`.
- **TypeScript 5.7+ narrowed `BufferSource`:** a plain `new Uint8Array(n)` is
  `Uint8Array<ArrayBufferLike>` and will not pass to `crypto.subtle`. Build the array over an
  explicit `new ArrayBuffer(n)` — see `fromBase64Url` in `src/lib/auth/crypto.ts`.
- **`@vitejs/plugin-react` v6 wants Vite 8; vitest 3.2 ships Vite 7.** Pinned to v5.
- Prism admin mock is up on :4011 and answers `GET /admin/me` 200 with any bearer token.
- This window introduced `next`/`react` to the lockfile (allowed on every branch by the manager,
  Memory-main 2026-09-04). Window 3 will hit the same peer-dependency resolutions.
- `tsconfig.base.json` is `module: NodeNext` + `verbatimModuleSyntax`; a Next app cannot extend it unchanged.

## How to run & test this package
```bash
pnpm mock                                  # Prism Admin API on :4011
pnpm compose:up                            # Keycloak :8180, Postgres :5433, OpenFGA :8081
pnpm --filter @platform/admin dev          # http://localhost:3000 (port fixed by the OIDC client)
pnpm --filter @platform/admin test         # Vitest, 23 tests
pnpm --filter @platform/admin typecheck
pnpm --filter @platform/admin build        # next build
```
Before finishing a task, from the repo root: `pnpm lint && pnpm format:check && pnpm typecheck`
— delete `apps/admin/.next/` first, or `format:check` will walk the build output.

## Later phases (do not start until Memory-main says so)
### Phase 2 — Commerce complete, brand 1 live
Complete Store view against the real Admin API: catalog with variants/media, order detail with fulfil/refund/return, customers, promotions, content links, settings.
- [ ] Catalog editor
- [ ] Order detail + actions
- [ ] Customers
- [ ] Promotions
- [ ] Settings

### Phase 3 — Multi-store & HQ
HQ view: all-store dashboard, role management UI, finance section gated, onboarding wizard.
- [ ] HQ dashboard
- [ ] Roles UI
- [ ] Onboarding wizard
