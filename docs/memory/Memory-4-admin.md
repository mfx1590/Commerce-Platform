# Memory 4 — Admin application
Window: 4 · Key: `admin` · Branch prefix: `admin/` · Model: Opus (Memory-main, owner decision 2026-09-04)
Last updated: 2026-09-05 · Contracts: contracts-v0.1 · Last commit: 3b5348c · Status: tasks 1.1-1.3 done; PR #42 green, 1.2 + 1.3 held local until it merges

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
- **1.3 — issue #26 Data-table primitive** · commit `dd90b81` · PR held until #42 merges
  - `DataTable` on TanStack Table v8 with `manualPagination/Sorting/Filtering`: the server decides
    what is in the page, the component renders it. Column visibility, bulk-action slot,
    loading/empty/error in place of the rows.
  - `src/lib/table/query-state.ts` (URL is the state) and `selection.ts` (no silent select-all),
    both pure and directly tested.
  - HQ Stores list wired to it with columns typed from `AdminComponents['Store']`.
  - 135 tests total. Verified against the live mock via a scratchpad stub that serves an owner
    principal and proxies the rest to Prism — the HQ nav, the guard and the real store rows all
    render.
  - **CONTRACT CHANGE #56 filed**: no list operation in contracts-v0.1 accepts `sort`/`order`.
    Sorting is carried in the URL but withheld from the request until it lands.

- **1.2 — issue #25 Permission-driven navigation + store switcher** · commit `3b5348c` · PR (opened after #42 merges)
  - Route groups `(hq)` and `(store)/[storeId]`; all twelve sections reachable, each placeholder
    naming the issue that delivers the real screen. 19 routes build.
  - `src/lib/nav/` is navigation as a pure function of the `Principal`: `sections.ts` (catalogue,
    every entry records the contract operation its gate comes from) and `relations.ts` (the ADR 0002
    OpenFGA model, so implication works). No `next/*` imports, so it is unit-testable directly.
  - Store switcher lists exactly `stores[]`; a server action re-validates the chosen id before
    remembering it in `admin_selected_store`, and the layout re-validates on every request.
  - Three gates: nav hides the link, the section guard 403s a typed URL, the Admin API re-checks
    `x-permission`. Only the third is security.
  - 78 tests (was 23). Verified against the live Prism mock by starting the built app on port 3200
    with a locally minted session cookie — see "How to verify without Keycloak" below.

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
- Nothing implementing. **Waiting on the manager to merge PR #42** (all five checks green as of
  2026-09-05). The moment it merges: push 1.2 + 1.3 to `admin/phase1`, open the 1.2 PR against
  `main`, then the 1.3 PR. Task 1.4 (issue #27, RHF + Zod form primitive) is next to build; it needs
  `react-hook-form` and `@hookform/resolvers`, and should derive schemas from `StoreInput` /
  `ProductInput` so #28 can use it for the Stores and Product forms.

## Next — Phase 1
- [x] 1.1 App skeleton, auth hook (Keycloak OIDC), session — #24, PR #42 (do not self-merge)
- [x] 1.2 Permission-driven navigation + store switcher — #25, PR (opened after #42 merges) (do not self-merge)
- [x] 1.3 Data-table primitive (TanStack Table): sort, filter, paginate, bulk — #26 (PR pending)
- [ ] 1.4 Form primitive (RHF + Zod) with server-error mapping — #27
- [ ] 1.5 Stores screen (HQ) and Catalog screens (Store view) against mock — #28
- [ ] 1.6 403 / empty / error states pattern — #29
- [ ] 1.7 Tests: nav renders per role fixture — #30

## Decisions made (with reasons)
- **Table state lives in the URL, not React state.** Paging, filtering and sorting are all
  server-driven, so the URL is the only place that can hold "the request the server should answer".
  It also makes every list linkable, back-button correct and reproducible from a bug report.
- **`parseTableQuery` keeps only declared filter keys.** Passing the raw query string through would
  forward `?injected=1` to the Admin API as an undeclared parameter — a 400 at best.
- **Sorting is withheld from the request, not from the UI.** contracts-v0.1 has no `sort`/`order`
  (#56). `toContractQuery` needs `{ sortable: true }` before it forwards them, and list screens pass
  `sortableColumns={[]}`, so nothing undefined is ever sent. Two lines per list to switch on later.
- **Selecting a page never selects the result set.** The escalation is a separate click offered only
  after a full page is ticked and only when more rows match, and it keeps an exclusion list.
  `describeSelection` gives bulk actions exact wording so a confirmation is never ambiguous.
- **Selection survives paging but not a filter change.** Ticking rows across pages is deliberate;
  an `all-matching` selection made under a different filter would silently mean something else.
- **`@tanstack/react-table` pinned to `^8`.** `@latest` resolves to v9, which has a different API
  (`createCoreRowModel`, `TableFeatures`) — worth knowing before anyone "upgrades" it.
- **Navigation is a pure function, deliberately.** `src/lib/nav/navigation.ts` takes a `Principal`
  and returns sections — no fetch, no `next/*`. That is what makes the seven-role matrix in
  `test/navigation.test.ts` a real test rather than a rendering snapshot, and it is what #30 builds on.
- **The relation algebra is mirrored client-side** (`src/lib/nav/relations.ts`) from ADR 0002 rather
  than asking the API per section. Rendering a section the user holds only by implication is correct;
  the API still re-checks `x-permission`, so a mistake here is cosmetic, never a hole. Kept in step
  with `infra/openfga/model.fga` — if window 2 changes the model, change this file.
- **HQ fixtures give their stores `relations: []`.** HQ roles reach every store by inheritance and
  the API may or may not expand that. Testing the emptier shape proves the nav derives store access
  from the organization relations instead of trusting the server to have expanded them.
- **`Content` is gated on `store_staff`** — it has no Admin API operation yet (window 6 owns the CMS),
  so it is gated like catalog authoring. Revisit when the CMS contract lands.
- **The selected store is a hint, not an authority.** The cookie is re-validated against `stores[]`
  on every request, so revoking access takes effect on the next page load rather than at cookie
  expiry. The server action validates before writing it, too.
- **A forbidden store renders the panel *inside* the shell**, switcher included, so the user can get
  back to their own stores instead of hitting a dead end.
- **`experimental.typedRoutes` off.** Nearly every link is `/${storeId}/${section}`, built at
  runtime; typed routes cannot check those and only added casts. Route correctness is covered by
  `test/navigation.test.ts` instead.
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
- **PR ordering.** The owner's call (2026-09-05): keep one branch, no stacked PRs. 1.2 and 1.3 stay
  local until #42 merges, then they are pushed to `admin/phase1` and get their own PRs in order.
- **CONTRACT CHANGE #56** (sort/order on list operations) — filed, not blocking: sorting is carried
  in the URL and simply not forwarded until the manager accepts it.
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
- The Prism mock always answers `GET /admin/me` with the **store-admin** example (no organization
  relations, brand-a + brand-b). So the HQ view cannot be exercised against the mock — HQ rendering
  is covered by the fixture tests instead. Prism can be steered with a `Prefer` header when #29
  needs specific responses.
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


### Verifying an HQ screen against the mock
Prism always answers `/admin/me` with the store-admin example, so HQ routes 403 against it. Put a
tiny stub in front: serve an owner `Principal` for `/admin/me`, proxy everything else to :4011, and
point `MOCK_ADMIN_API_URL` at it. That is how the HQ nav, the section guard and the Stores table were
verified for 1.3. Keep the stub in the scratchpad — it is a harness, not repo code.

### How to verify without Keycloak (while #43 is open)
The staff realm forces TOTP and port 3000 is taken, so drive the built app directly:
1. `pnpm --filter @platform/admin build`
2. `ADMIN_SESSION_SECRET='admin-dev-session-secret-not-for-production' npx next start -p 3200`
   (`next start` sets NODE_ENV=production, so the secret is required — that guard is working.)
3. Mint a session cookie with the same scheme as `src/lib/auth/session.ts` (SHA-256 of the secret →
   AES-GCM, 12-byte IV prefix, base64url, chunked at 3500 chars) and `curl -H "Cookie: admin_session.0=…"`.
   The access token can be any string: the Prism mock accepts any bearer value.
Confirmed this way: `/` redirects to the landing section; `/stores` and `/finance` render the 403
panel for a store-only principal; `/{brand-a}/catalog` renders with the full store nav;
`/{brand-c}/catalog` renders the store-forbidden panel with the switcher still showing only brand-a
and brand-b; a cookie naming brand-c is dropped in favour of brand-a; no server errors.

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
