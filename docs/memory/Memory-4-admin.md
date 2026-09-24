# Memory 4 — Admin application
Window: 4 · Key: `admin` · Branch prefix: `admin/` · Model: Opus (Memory-main, owner decision 2026-09-04)
Last updated: 2026-09-24 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `admin/phase2` · Status: Phase 2 in progress (#154 merged, 2.1 in PR, 2.2 next)

## Identity (does not change)
Owned paths (write):
- `apps/admin/**`
Reads:
- packages/contracts
- packages/auth-sdk
Never touches:
- apps/core internals
- packages/*

## Mission — Phase 2 (Commerce complete, brand 1 live)
Complete Store view against the real Admin API: catalog with variants/media, order detail with fulfil/refund/return, customers, promotions, content links, settings. Wave B — starts when core 2.1–2.2 have merged; the admin may start against the mocks as soon as contracts-v0.3 is tagged.

## Done
- **REQUEST #251 — `AdminResponse` maps 202 bodies** · 2026-09-24 · (sha in the PR) · resumed
  after the pause: main merged (284 commits, contracts-v0.4.5, 106 admin operations), `pnpm
  install`, workspace packages rebuilt, local `.env` DB rows → `127.0.0.1:5433`. `SuccessBody`
  now 200 → 201 → 202 → null; type-level test pins getProduct/createProduct/materializeSegment/
  archiveProduct/eraseCustomer. Gate: lint, typecheck, format, 368 unit.

- **2.1b — issue #192 The Medusa rail and the dark design system** · 2026-09-09 · commits
  `fafdc7b` (rail), `da1fe0e` (intro state machine), `c568bf4` (screenshots) · **PR #205** (in review)
  - Sidebar replaced by `src/components/rail/`: `MedusaRail` (client: masked head `<image>`, one
    procedural SVG serpent per already-filtered `NavItem`, Store/HQ scope switch shown only when
    both scopes have items, one rAF loop writing attributes directly and pausing when hidden,
    Canvas motes, intro once per session, gaze), `RailList` (plain links + `aria-current`),
    `serpent-geometry.ts` (pure: anchors, centred tips capped at 120 apart, bezier with sway/lift/
    gaze, head angle from the derivative, numeric arc length — no `getTotalLength`), `active.ts`,
    `rail.config.ts`, `medusa-rail.module.css`. `side-nav.tsx` deleted; `AppShell` = rail + slim bar.
  - Tokens: `globals.css` `@theme` is the dark set from the brief mapped onto the existing semantic
    names (+ `gold`, eyes only; `surface-2`, `accent-deep`); primitives restyled with no rewrites;
    `h1` = Cinzel. Fonts committed as latin woff2 in `public/fonts` (OFL) via `next/font/local`.
    Head asset `public/medusa-face.jpg` 116.6 KB.
  - A11y: serpents `role=button` + `tabindex` + `aria-pressed` + focus ring; Enter/Space; list view
    under reduced motion (toggle locked, no rAF, intro flag untouched — a real defect found by the
    test: the first client render fired the effects before the media query was read; fixed with a
    `decided` gate), on touch by default, persisted in `localStorage medusa-list`; 860 px band.
  - Tests: `serpent-geometry.test.ts` (15), `rail.test.tsx` (16, axe on both views, role fixtures),
    `shell.test.tsx` → RailList; 367 unit total. e2e: `rail.spec.ts` 4/4 on the mock + HQ-scope
    test; store-admin journey asserts buttons; `staff.ts` gained `signInAs`, `FINANCE`,
    `settledRail`. Screenshots `apps/admin/docs/medusa-rail/{store-scope,list-view,hq-scope}.png`.
  - **Not done, stated in the PR:** `E2E_API=core` re-run — the core does not boot from `main`
    (**#202**, window 9's CLI script in Medusa's auto-loaded `src/jobs`). `hq-scope.png` was
    rendered by the same HQ test against a Prism started on a scratch copy of the spec whose
    `/admin/me` example is the seeded `finance` principal (real app, real Keycloak sign-in).
  - Nit: `admin.ts` header now says Admin API 0.4.0.

- **Admin API 0.4.0 follow-up on PR #184 — the #180 gap test flipped** · (sha in the next entry's
  commit list) · main merged at b4d83f6 (contracts 0.4.0, #185). `test-contract/catalog.test.tsx`
  now drives `Prefer: code=403` and `code=401` on `updateProduct` through `adminRequest` →
  `toActionResult` and asserts the `refusal` shape with no field errors. Version comments, README,
  CLAUDE.md → 0.4.0. Gate: lint, typecheck, format, 336 unit, 21 contract.

- **2.1 — issue #113 Catalog editor** · commits `ded75d4` (part 1) + `0e5f308` (part 2) · **PR #184** (in review) · Admin API 0.3.0, no contract change
  - Refusals render the state panel: `ActionResult` error carries `refusal: {status, error}` for
    401/403, `ActionRefusal` renders `ApiStatePanel` in the product form, publish controls,
    variants and categories panels. Publish behind a confirmation (emits `product.published`).
    Media move up/down; `position` renumbered server-side only. Category picker sends `null` for
    "none" (the empty string silently failed validation with no error slot — a real 1.5 bug).
  - `test-contract/catalog.test.tsx` (14): wrappers, the spec's 400/409 examples under the Handle
    input, and the screens through the *real* server actions against Prism (`prism.ts` spawns
    per suite on :4212; `states.test.tsx` keeps :4211). **CONTRACT CHANGE #180**: no catalog
    operation documents 401/403, so Prism cannot produce one there.
  - e2e on the mock 11/11 (create → editor, publish asks first, media reorder). **Real core:**
    `e2e/catalog-core.spec.ts` (opt-in `E2E_API=core`) passed against core 2.2 on :9000 —
    create → 2 variants → publish → listed, screenshots in `apps/admin/docs/real-core-run/`.
  - Unit 336, contract 20. README/CLAUDE.md/CHANGELOG updated.
  - **Incident:** the Phase 1 admin session ("Window 4 Admin app phase 1 setup") was also given
    2.1 and edited this worktree in parallel for ~25 minutes; it built steps 1–4 of the plan and
    filed #180. Its uncommitted work was reviewed, formatted and taken over here (commit
    `ded75d4`); it was told to stop via a session message and is no longer running.

- **REQUEST #154 — `playwright.config.ts` honours `E2E_CHANNEL`** · commit `a34e583` · PR #171 (in review)
  - `const CHANNEL = process.env.E2E_CHANNEL ?? (CI ? undefined : 'chrome')` and
    `const browser = CHANNEL ? { channel: CHANNEL } : {}` spread into `use` and the chromium
    project; no pinned channel anywhere. `E2E_CHANNEL=''` means bundled chromium,
    `E2E_CHANNEL=chrome` means the machine's Chrome, unset keeps the local/CI fallback.
  - Verified: `playwright test --list` loads the config under both values (8 tests); lint,
    typecheck, format, 304 unit tests unchanged. CLAUDE.md + CHANGELOG updated. Window 5 drops
    the double browser install in `infra/ci/run-e2e.sh` once this merges.

- **Admin API 0.2.1 — Customers gated on `support`** · commit `c41e731` · PR #94
  - `listCustomers`/`getCustomer` moved from `viewer` to `support`, so the section follows: an
    organization `support`, a `store_admin` or an `owner` — no longer `store_staff`, `finance`,
    `operations` or `analyst`. Customer records are personal data; reading them is not implied by
    merely holding a relation on the store.
  - **The Playwright journey ran for the first time and passes 8/8** (`PORT=3200`, after window 2
    registered `http://localhost:3200/*` live). It found three real bugs, all in the test:
    `getByLabel(/password/i)` matched Keycloak's "Show password" toggle as well as the input;
    the shell shows `display_name` from `GET /admin/me` ("Store Admin") rather than the ID token's
    `name` ("Sam StoreAdmin"); and the sign-out check raced the logout chain and leaned on Keycloak's
    SSO policy — it now pins that the app's own session cookies are gone, which is the part this app
    owns.
  - 304 unit + 6 contract + 8 e2e.

- **1.8 — issue #63 Reserve the Marketing section** · commit `422a7fb`
  - HQ Marketing gated on `analyst` (owner implies it); Store Marketing on `store_staff`
    (store_admin implies it) — so finance and operations see neither, as the issue asks.
  - A placeholder page each, self-contained on purpose: one file, no components of their own, no API
    calls (no marketing contract until contracts-v0.3), so window 17 inherits a clean folder.
  - Fixtures updated in both `navigation.test.ts` and `role-access.test.ts`; README and CLAUDE.md
    record both folders as reserved for window 17.
  - 302 tests. **This completes the Phase 1 Next list.**

- **1.7 — issue #30 Tests per role fixture** · commit `09522a2`
  - `test/role-access.test.ts`: what each role may *open*, next to `navigation.test.ts`'s what each
    role *sees*. A URL can be typed, so the two only agree if the guards and the navigation come from
    the same rules — and every section is now decided for all seven seeded roles, so adding one
    without deciding who reaches it fails a test.
  - Playwright store-admin journey (sign in → switch store → products), plus the foreign store's 403
    with the switcher intact, an HQ section refused, and sign-out ending the realm session. 8 tests,
    all discovered by `playwright test --list`.
  - **Not yet executed**: the journey needs port 3000 (the only redirect URI `admin-app` registers)
    and an unrelated project still holds it. Everything it asserts is duplicated at the unit level.
  - CI wiring filed as REQUEST #80 — `.github/workflows/**` is not this window's.
  - 299 unit tests.

- **REQUEST #68 — `$PORT`, `/health`, and media position renumbering** · commit `b132628` · PR #78
  - `start` is plain `next start`, so the app honours `$PORT` (default 3000). A hard-coded `--port`
    beats `$PORT`, so the container would listen on one port while Docker and Kubernetes probed
    another, the pod would never become ready, and the deploy would roll back.
  - Added `GET /health` — the half of the image contract the request only mentions in passing, and
    which this app did not have: the probe would have been **redirected to the sign-in page**. It is
    excluded from the middleware matcher and reports only that the process is up; a liveness probe
    that fails when Keycloak or the Admin API is down gets the container killed and restarted, which
    fixes nothing and removes the instance that could still serve the error panels.
  - Media positions are renumbered from the array order before the body is sent. The form assigned a
    position on append and never revisited it, so removing the first of three images sent 1 and 2
    with no 0, and appending afterwards reused a number already in use — anything ordering images
    downstream would have been working from duplicates.
  - 274 tests.

- **1.6 — issue #29 The 401/403/404/empty/error pattern** · commits `a2eac56` and `b132628` ·
  **PR #78**, all seven checks green.
  - `ApiStatePanel` is the single entry point; screens hand it a failed result instead of branching
    on status. 401 offers signing in again rather than a retry that would fail identically; 403 names
    the relation and object; 404 says which store was searched, because the API scopes it; only
    network/5xx gets a retry.
  - Empty is split from error, and "nothing yet" from "filter matched nothing" — different problems,
    different next actions.
  - Router boundaries `error.tsx` / `not-found.tsx`; the error boundary shows only `digest`, since a
    server error message can contain whatever the server was holding.
  - `/states` renders every panel, dev only, from the same components the screens use.
  - New `test:contract` suite boots Prism itself and drives it with `Prefer: code=403` (plus 401,
    404, 200) — proving a real refusal becomes the panel that names the relation. Kept out of
    `pnpm test` so the unit suite stays fast.
  - Found and fixed: **the test files had never been typechecked** — `tsconfig.json` only included
    `src/`.
  - 266 unit + 6 contract tests.

- **1.5 review follow-up** (manager BLOCK on PR #67, all three addressed) · commit `a1b297a`
  1. `createVariantAction` had no caller. The product page now reconciles the matrix against
     existing variants and offers the gap — one button per row plus "Create all N" — and
     `updateVariant` is wired for inline SKU/title/price editing. The page copy claiming that saving
     options creates the matrix was wrong and is gone. Product media (`ProductInput.media`) added to
     the form, URL-validated.
  2. README no longer claims `.env` is optional; `ADMIN_SESSION_SECRET` is listed as required.
  3. The stale "sorting withheld / `sortableColumns={[]}`" decision is replaced by the 0.2.0 one.
  - 248 tests (was 229).

- **1.5 — issue #28 Stores (HQ) + Catalog (Store view)** · commit `71eb9a5`
  - Every `registry` and `catalog` operation has a typed wrapper and is reachable from the UI.
    HQ: `/stores`, `/stores/new`, `/stores/{id}` (record + domains + sales channels + API keys).
    Store: `/{storeId}/catalog` (filters + sort), `/catalog/new`, `/catalog/{id}` (edit, publish,
    archive, variants), `/catalog/categories`.
  - The show-once API key lives in one component's state and nowhere else; the list only ever holds
    `key_prefix`, so there is no control that could bring the value back.
  - `variantMatrix` is a pure, separately tested cross-product; the product form previews it live.
  - **Two bugs only running the app could find** (unit tests and `next build` were both green):
    1. A plain function (`redirectTo`) and an arrow-wrapped server action passed from a server
       component to a client one — React refuses both. Actions are now `.bind(null, …)`ed and the
       redirect is a string prefix.
    2. **Constants exported from a `'use client'` module become client references when a server
       component imports them.** `PRODUCT_FILTER_KEYS` threw "b is not iterable"; worse,
       `STORES_TABLE_DEFAULTS` failed *silently* (property reads returned undefined), so the stores
       table's default sort was never applied. Both moved to plain `*.config.ts` modules.
  - Verified: all seven screens render 200 with zero server errors against the mock, and
    `/stores` now really carries `aria-sort="descending"` on Created.
  - Follow-ups in the same task: sorting turned on against Admin API 0.2.0; `ADMIN_SESSION_SECRET`
    made mandatory everywhere; callback-route and middleware-refresh tests added; the overstated
    "verified end to end" claim corrected (see the 1.1 entry).
  - 229 tests. `pnpm lint`, `format:check`, `typecheck` (15/15), `check-ownership` green.

- **1.4 — issue #27 Form primitive (RHF + Zod)** · commit `f2c8df5` · merged in PR #42
  - `useContractForm(schema, action)`: one Zod schema validates on the client and re-validates in
    the server action, so the two cannot disagree.
  - Schemas hand-written, not generated: the contract marks nearly every input property optional
    because POST and PATCH share a schema, so a generated schema would accept an empty create form.
    A `MatchesContract` type assertion fails the build on drift — **verified it actually fires** for
    both a typo'd field name and a wrong value type.
  - Server-error mapping: `400 details.field` / `409 conflict` attach to that input and focus it;
    an unknown field is raised to form level with its name kept; 403 names the missing relation;
    stale errors clear on the next submit.
  - `MoneyField` edits integer minor units, parsed by string manipulation (never `x * 100`),
    currency-aware decimals, comma accepted, group separators rejected.
  - Optimistic UI runs only when an `optimistic` callback is passed.
  - 175 tests total.

- **1.3 — issue #26 Data-table primitive** · commit `dd90b81` · merged in PR #42
  - `DataTable` on TanStack Table v8 with `manualPagination/Sorting/Filtering`: the server decides
    what is in the page, the component renders it. Column visibility, bulk-action slot,
    loading/empty/error in place of the rows.
  - `src/lib/table/query-state.ts` (URL is the state) and `selection.ts` (no silent select-all),
    both pure and directly tested.
  - HQ Stores list wired to it with columns typed from `AdminComponents['Store']`.
  - 135 tests total. Verified against the live mock via a scratchpad stub that serves an owner
    principal and proxies the rest to Prism — the HQ nav, the guard and the real store rows all
    render.
  - **CONTRACT CHANGE #56 filed** — accepted as Admin API 0.2.0 during task 1.5, so sorting is now
    forwarded for `listStores` and `listProducts`. At the time of this task it was carried in the URL
    only.

- **1.2 — issue #25 Permission-driven navigation + store switcher** · commit `3b5348c` · merged in PR #42
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
  - **Correction (2026-09-05):** an earlier version of this entry claimed the OIDC flow was verified
    "end to end" headlessly. It was not. The headless run reached discovery → the PKCE authorization
    request → the realm's sign-in form → the password being accepted, and then stopped at
    `login-actions/required-action?execution=CONFIGURE_TOTP`. **No authorization code was ever
    issued, so `exchangeCode` and the token endpoint were never exercised against real Keycloak.**
    What was independently confirmed: the client is `publicClient=true` with
    `pkce.code.challenge.method=S256` and redirect `http://localhost:3000/*` (Keycloak admin API),
    and `GET /admin/me` answers on the mock with a bearer token. The token exchange and refresh paths
    are covered by unit tests (task 1.5) — not by a live round-trip.
  - **Now verified (2026-09-06), after #65 fixed #43.** The staff realm's OTP is CONDITIONAL
    (`conditional-user-configured`), so `store-admin` signs in with a password alone while `owner`
    stays TOTP-enrolled to keep the challenge path testable. The whole flow was driven through the
    app's own routes against real Keycloak: `/api/auth/login` (PKCE S256, three transient cookies) →
    the realm's sign-in form → password accepted with no OTP challenge → `/api/auth/callback`
    exchanging a **real** authorization code with the **real** token endpoint → session sealed into
    two `admin_session.N` cookies → returned to the `returnTo` → `/{brand-a}/catalog` rendering 200
    with the products table and "Store Admin" from the real ID-token claims → logout redirecting to
    the realm's end-session endpoint with `id_token_hint`. Replaying the code with a wrong verifier
    is rejected 400. Zero server errors throughout. **#24's last acceptance criterion is met.**
    Caveat: the app listened on 3200 (another project still holds 3000) with `ADMIN_APP_URL=3000` so
    the `redirect_uri` matched the registered one — the only simulated hop is the browser itself.

## In progress
- **#114 · 2.2 Orders** — plan of 2026-09-08 to be refreshed against contracts-v0.4.5 (new since:
  `updateOrderLineItem` / `cancelOrderLineItem` before fulfilment, `pickShipment` / `packShipment`,
  `listPickLists`, 401/403 everywhere) and to fold in the four rail nits from #205 (**not on
  GitHub — asked the manager for the list, 2026-09-24**). Core is feature-complete on main and
  #202 is fixed, so the real-core verification runs at the end of the task. Building locally while
  #184 is in review; no push until the manager confirms. Contracts 0.4.0 (#185, 401/403 on every
  operation) lands today: merge main and retarget the refusal contract tests at the spec's examples.
  1. **Wrappers** in `src/lib/api/admin.ts`: `listOrders` (filters status, payment_status,
     fulfillment_status, q, placed_from/to; sort placed_at/display_id/total/status), `getOrder`,
     `cancelOrder`, `createRefund` (**`Idempotency-Key` header** via `adminCall.headers`),
     `createReturn`, `createShipment`, `updateShipment`, `receiveReturn`; `listWarehouses` exists.
  2. **List** `/{storeId}/orders`: data-table, URL-driven filters + sort from the contract enums
     (`orders-table.config.ts`), money from `{amount_minor, currency}` with the store's
     `default_locale` (`getStore` in parallel, fails alone), status/payment/fulfilment badges,
     empty vs filter-matched-nothing, `ApiStatePanel` on failure.
  3. **Detail** `/{storeId}/orders/{orderId}` (server component renders the PII: email, addresses):
     header + three badges, lines (qty, unit, discount, tax, total, fulfilled/returned), totals
     block, shipping method, payments/refunds/shipments/returns as one timeline sorted by time,
     `cancel_reason` when set.
  4. **Actions panel** (client, each behind a confirmation, each gated in the UI by the relation
     from `/admin/me` via `src/lib/nav/relations.ts`, always re-checked by the API → `ActionRefusal`):
     Cancel (`store_admin`, reason required) · Fulfil = `createShipment` (`operations` on
     organization:hq: warehouse picker from `listWarehouses`, per-line quantity ≤ remaining,
     carrier/service) · Refund (`support`: `MoneyField` ≤ captured − refunded, reason enum,
     optional payment) · Request return (`support`: per-line quantity ≤ shipped − returned, reason).
  5. **Idempotency**: the refund form mints `crypto.randomUUID()` when it opens and keeps it until a
     success; a retry after a network error (status 0) or 5xx reuses it, a success mints a new one.
     Unit test: action fails with status 0 then succeeds → both calls carry the same key; the next
     refund carries a different one.
  6. **Server actions** `src/app/actions/orders.ts` + Zod schemas (`MatchesContract` where the
     contract has a named input; the inline bodies get hand-written schemas).
  7. **Tests**: unit (table config, money rendering never via floats, gating per role fixture,
     idempotency, confirmations), contract `test-contract/orders.test.tsx` (list/detail/cancel/
     refund 201 + documented 403/409, return 201, shipment 201; after #185: 401/403 examples on the
     order operations), 403/empty/error through `ApiStatePanel`; e2e: orders list → detail on the mock.
  8. **Real core at the end** (core 2.3 / PR #174 merges within the hour): merge main, run
     list/detail (+ whichever actions the core implements) against :9000, document; refusals →
     issue for window 1 with exact request/response.
  9. README (orders section), CHANGELOG, memory; `pnpm lint && pnpm typecheck && pnpm test --filter
     @platform/admin` + `test:contract`; PR with the acceptance criteria.
  **Estimate: 50–70 tool calls.** Not in scope: shipment status updates UI beyond `updateShipment`
  wrapper (window 8's labels/tracking), `receiveReturn` UI (HQ warehouse, Phase 3 window 11) —
  wrappers only.

### Open requests, none blocking
- ~~**#82**~~ — **resolved.** Window 2 landed 3200 in #85; `staff-realm.json` on `main` carries it in
  `redirectUris`, `webOrigins` **and** `post.logout.redirect.uris`. My earlier "the repo and the
  running realm disagree" claim was wrong: I compared the live realm against this branch's stale copy
  of the file, before #85 had been merged in. Corrected on the issue.
- **#80** — CI job for the Playwright journeys (admin and storefront).
- ~~**#93**~~ — **applied on main**: `**/test-results/` and `**/playwright-report/` are in the root
  `.prettierignore`, so a Playwright run no longer breaks `pnpm format:check`.

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#113 · 2.1** Catalog editor — in PR
- [ ] **#114 · 2.2** Orders: list, detail, actions
- [ ] **#115 · 2.3** Customers and consent (support-gated)
- [ ] **#116 · 2.4** Promotions and price lists screens
- [ ] **#117 · 2.5** Store settings: domains, locales/currencies, sales channels, API keys
- [ ] **#118 · 2.6** Real-API hardening and e2e against the core

## Decisions made (with reasons)
- **A 401/403 from a mutation is a `refusal`, not a `formError`.** A relation you do not hold is
  not a validation message; rendering the same `ApiStatePanel` the screen would render makes the
  refusal look identical whether it came from loading or from Save, and it can never be a silent
  no-op.
- **Publish asks first.** It emits `product.published` and is the moment shoppers see the product;
  that is not a mis-click away from Archive.
- **The form never sets media `position`.** The server action renumbers from the array order, so
  a client-side number was only a second source of truth that could disagree.
- **Contract tests drive the real server actions.** `server-only`, the session and `next/cache`
  are the only stubs, so a click on `PublishControls` in `test-contract/` is a real POST to Prism.
  Error codes the wrappers cannot ask for go through `adminCall` with `Prefer` — no test-only
  door in shipped code.
- **The real-core journey is opt-in (`E2E_API=core`) and reuses a server you started.** It writes
  real rows; the default run stays hermetic on Prism. The config's `reuseExistingServer` is what
  makes this work without a second config.
- **Customers is gated on `support`, not `viewer`** (Admin API 0.2.1). Customer records are personal
  data, so a relation on the store is no longer enough to read them — `store_staff`, `finance`,
  `operations` and `analyst` all lose the section, while an organization `support` keeps it.
- **The e2e sign-out test asserts the app's own cookies are gone, not the landing URL.** Whether the
  realm then re-authenticates silently is Keycloak's SSO policy; asserting on it would be testing
  someone else's configuration, and flakily.
- **`pnpm dev --reset` is not used to refresh the staff realm.** It is `docker compose down -v`,
  which also wipes Postgres, OpenFGA and Redpanda — the other windows' migrated and seeded data,
  while they are building. `node infra/keycloak/reimport.mjs staff` plus a Keycloak-only restart
  achieves the same thing for the realm and touches nothing else. Verified twice that the running
  realm then matches the repo JSON exactly.
- **`ApiStatePanel` dispatches; screens do not branch on status.** One dispatcher is what makes the
  pattern one pattern — a 401 in a data-table looks like a 401 on a detail page because it is the
  same component, not because two places happen to agree.
- **Only network/5xx offers a retry.** Retrying a 403 fails identically, and a button that cannot
  work is worse than no button.
- **The error boundary shows `digest`, never the message.** A server-side error message may contain
  whatever the server was holding, and this app handles tokens and customer data.
- **Contract tests live in `test-contract/` with their own vitest config.** They boot Prism, which
  takes seconds and needs a free port; `pnpm test` stays fast and hermetic.
- **Creating variants is a deliberate act, not a side effect of saving options.** A variant is a
  sellable thing with its own SKU, price and stock; adding a colour to a live product would
  otherwise silently POST several. The page offers the gap between the matrix and what exists, one
  button per row plus an explicit "create all" that names the count — the same principle as the
  data-table refusing to select a result set behind one checkbox. A bulk create stops at the first
  refusal, because a half-created matrix is worse than a stated failure.
- **Table configuration lives in plain `*.config.ts` modules, never in the `'use client'` file.**
  A constant exported from a client module and imported by a server component arrives as a client
  reference: arrays stop being iterable and object properties read as `undefined` *silently*. That
  second failure mode had already broken the stores table's default sort without any test noticing.
- **Server actions cross to client components bound, never wrapped.** `action={(v) => act(id, v)}`
  is a plain function and React refuses it; `action={act.bind(null, id)}` is a server action
  reference and is fine. Likewise a `redirectTo` callback became a `redirectBase` string.
- **`compact()` before every request body.** Zod's `key?: T | undefined` and the contract's exact
  optional `key?: T` differ under `exactOptionalPropertyTypes`, and on PATCH the difference is real:
  an explicit `undefined` is not the same request as an omitted key.
- **Store detail loads its four sub-resources in parallel and lets each fail alone.** Listing API
  keys needs `store_admin` while reading the store needs only `viewer`; one 403 must not replace the
  whole page with an error.
- **`ADMIN_SESSION_SECRET` has no fallback.** A constant committed to the repo is a key everyone
  has, and "development" is one mis-set `NODE_ENV` from production. Failing loudly with a generate
  command costs one command; the silent version does not fail until it matters.
- **Form schemas are hand-written, not generated from the contract.** `admin-api.yaml` marks almost
  every input property optional because POST and PATCH share one schema (`StoreInput` has no
  `required` list at all). A generated schema would accept an empty create form and let the server
  say no. The `MatchesContract` assertion keeps them honest — it was checked to fail on a typo'd
  field name and on a wrong value type, so it is not decorative.
- **Server errors attach to the control that caused them.** The contract names the field, so pinning
  it there is free; the only judgement call is what to do with a field the form does not render, and
  that is raised to form level *with the field name in the text* rather than silently dropped.
- **Money never goes through a float.** `12.10 * 100` is `1209.9999999999998`; `parseMoney` works on
  the string. Currency decimals come from `Intl.NumberFormat`, so JPY takes 0 and KWD 3 for free.
- **Optimistic UI is opt-in.** A form that shows a save as done before the server agreed is a form
  that lies about whether a price changed.
- **`MoneyField` adjusts state during render, not in an effect,** when the currency changes. The repo
  ESLint config has no `react-hooks` plugin, so an `eslint-disable` for `exhaustive-deps` is an
  error ("rule not found"); the render-time pattern needs no suppression and is what React documents.
- **Table state lives in the URL, not React state.** Paging, filtering and sorting are all
  server-driven, so the URL is the only place that can hold "the request the server should answer".
  It also makes every list linkable, back-button correct and reproducible from a bug report.
- **`parseTableQuery` keeps only declared filter keys.** Passing the raw query string through would
  forward `?injected=1` to the Admin API as an undeclared parameter — a 400 at best.
- **Sorting is server-driven and opt-in per operation.** CONTRACT CHANGE #56 was accepted as
  **Admin API 0.2.0**, so `listStores` (`code, name, status, created_at`) and `listProducts`
  (`title, handle, status, created_at, updated_at`) sort on the server. `toContractQuery` still
  requires `{ sortable: true }`, because only four list operations gained the parameters and each has
  its own enum — a table built on any other endpoint must not be able to send one. A screen declares
  the contract's enum in `sortableColumns` and the contract's default in its `TableQueryDefaults`, so
  the default stays out of the URL.
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
- **PR ordering** (manager note in CLAUDE.md): one branch, one open PR at a time. Open a PR, wait
  for the manager to merge it, then continue on the same branch — never stacked branches.
- **CONTRACT CHANGE #56 accepted** as Admin API 0.2.0; sorting is live for `listStores` and
  `listProducts`. Nothing blocked.
- ~~**#24 acceptance criterion 1 (browser sign-in round-trip)**~~ — **done 2026-09-06.** The code is complete; the OIDC flow is verified up to the sign-in form
  only (see the correction in the 1.1 entry — no code was issued, so no live token exchange).
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
- **Two sessions on one worktree corrupt each other silently.** A resumed Phase 1 session and this
  one both received "go on 2.1" and both edited `apps/admin`; `git status` showing files you did
  not touch is the tell. Check `list_sessions` for another running session with the same `cwd`
  before editing, and message it to stop rather than racing it.
- **No catalog operation in Admin API 0.3.0 documents 401/403**, so `Prefer: code=403` on those
  paths makes Prism answer 404/normally, not 403 — a contract test that expects the refusal there
  passes for the wrong reason or fails confusingly. Drive refusals on a registry operation
  (`createStore` documents 403) until #180 lands.
- **`listProducts` has no example in the spec**, so Prism generates the page from the schema:
  assert on shape (row → link to its own id), never on "Classic Tee".
- **The mock's only product example is already `published`**, so a Publish click cannot be
  exercised on Prism; the contract suite overrides the status to `draft` before rendering, and the
  real-core journey does the actual click.
- **Playwright `getByLabel('Title', { exact: false })` also matches "Subtitle"** (strict-mode
  violation). Anchor it: `getByLabel(/^Title/)`.
- **Async form submits in tests:** the action runs inside `startTransition`, so assert with
  `findBy*`/`waitFor` after the click; `getBy*` right after `user.click` is a race that only
  sometimes loses.
- **Check `origin/main`, not your branch, before reporting that a shared file is missing something.**
  I told window 2 the realm JSON lacked the 3200 redirect URI; it did not — their #85 had landed on
  `main` and I was reading this branch's older copy. `git fetch && git show origin/main:<path>`
  would have caught it.
- **Keycloak's login form breaks `getByLabel`.** A "Show password" toggle carries
  `aria-label="Show password"`, so `getByLabel(/password/i)` matches two elements and trips
  Playwright strict mode. Use `getByRole('textbox', { name: 'Password', exact: true })`.
- **The shell's display name comes from `GET /admin/me`, not the ID token.** The mock says
  "Store Admin"; the DB seed and the token claim say "Sam StoreAdmin". Assert the API's value.
- **A `cat > file` with no heredoc hangs forever waiting on stdin, and takes the rest of the `&&`
  chain with it.** One did, for hours. Worse, killing the stranded process let the chain *resume*:
  it re-ran `python docs7.py` (duplicating a CHANGELOG section) and `gh issue create` (filing #83, a
  duplicate of #80, since closed). Two lessons: never leave a bare `cat >` in a chain, and after any
  hung-then-killed command, check `git status` **and** whatever side effects the tail would have had.
- **Restacking rewrites shas, so the sha-recording commits go stale.** Every unstack/restack round
  (reset to origin → fix → push → rebase the held work back on) rewrites the held commits, and the
  memory entries that name them then point at commits that no longer exist. Re-grep the file for the
  old shas after every rebase.
- When resolving a rebase conflict in this memory file, take the *incoming* version (`--theirs`,
  which carries the newer task entry) and re-apply the corrections by script — the file is edited by
  nearly every commit, so it conflicts on nearly every rebase.
- **The Playwright journey cannot run while another process holds port 3000.** `admin-app` registers
  `http://localhost:3000/*` as its only redirect URI, so Keycloak sends the callback there whatever
  port the app listens on — moving `$PORT` alone does not help. `playwright.config.ts` honours
  `$PORT` (default 3000) and derives `ADMIN_APP_URL` from it, so **REQUEST #82** (register
  `http://localhost:3200/*` on the dev realm) is all that stands between this and
  `PORT=3200 pnpm --filter @platform/admin e2e`.
- **Re-importing the staff realm after window 2 changes it:** `node infra/keycloak/reimport.mjs staff`
  deletes and recreates the realm through the admin API without touching any volume, then restart
  just Keycloak (`docker compose -f infra/docker/docker-compose.yml restart keycloak`). **Do not use
  `pnpm dev --reset` for this** — it is `docker compose down -v` and wipes Postgres, OpenFGA and
  Redpanda too, which destroys the other windows' migrated and seeded data while they are building.
- Staff realm since #65: OTP is CONDITIONAL, so six of the seven seeded users sign in with a password
  alone; `owner` is pre-enrolled with a dev TOTP secret documented in `infra/keycloak/README.md` so
  the challenge path stays testable.
- Port 3000 is still held by an unrelated project on this machine, and `admin-app` registers only
  `http://localhost:3000/*`. Workaround for local verification: run the app on another port with
  `ADMIN_APP_URL=http://localhost:3000` so the `redirect_uri` still matches.
- **`tsconfig.json` only included `src/`, so no test file was ever typechecked.** Fixed in 1.6;
  worth checking in any other window that scaffolded its own tsconfig.
- **Anything a server component imports must come from a non-`'use client'` module** — not just
  functions, constants too. The silent variant (object properties reading `undefined`) is the
  dangerous one.
- **`pnpm install` after merging main.** The merge brought window 1's and 2's new dependencies
  (`@openfga/sdk`, `@medusajs/*`, `express`); `pnpm typecheck` fails across those packages until
  they are installed, and the errors look like their bugs rather than a missing install.
- Window 17 (marketing) was added to `docs/ownership.md` and owns
  `apps/admin/src/app/(store)/[storeId]/marketing/**` and `apps/admin/src/app/(hq)/marketing/**` —
  inside this app's tree but not this window's to write.
- **No `react-hooks` ESLint plugin in the repo config.** An `// eslint-disable-next-line
  react-hooks/exhaustive-deps` comment is itself a lint *error* ("Definition for rule was not
  found"). Restructure instead of suppressing.
- **`@hookform/resolvers` + Zod 4 under `exactOptionalPropertyTypes`:** type the schema as
  `ZodType<TValues, TValues>` (output = input), or `zodResolver` will not line up with
  `useForm<TValues>`.
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
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

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
### Phase 3 — Multi-store & HQ
HQ view: all-store dashboard, role management UI, finance section gated, onboarding wizard.
- [ ] HQ dashboard
- [ ] Roles UI
- [ ] Onboarding wizard
