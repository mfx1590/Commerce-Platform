# Changelog — @platform/admin

## Unreleased

### Added — task 2.2, issue #114: Orders (Admin API 0.4.5)

- **List** `/{storeId}/orders`: `listOrders` with the contract's filters (status, payment status,
  fulfilment status as pressable pills; `q` for order number or email) and sorts
  (placed_at/display_id/total/status), all in the URL. Money is rendered from
  `{amount_minor, currency}` in the store's `default_locale` (`getStore` read in parallel, fails
  alone → en-GB), never through a float on the way; every status is a pill with its name.
- **Detail** `/{storeId}/orders/{orderId}`: lines with unit/discount/tax/total and shipped/returned
  counters, totals, shipping method and promotion codes, the customer's email and addresses
  (rendered in the server component — PII never becomes a client prop), and one **timeline** built
  from payments, refunds, shipments and returns (`src/lib/orders/timeline.ts`, pure).
- **Actions**, each behind an inline confirmation, each offered only when the relation
  (`src/lib/orders/permissions.ts`, mirrors the operations' `x-permission`) and the order's state
  (`src/lib/orders/quantities.ts`) allow it, each re-checked by the API with a refusal rendered as
  `ActionRefusal`: cancel (`store_admin`, reason required, only while nothing shipped); **line
  edits before fulfilment** — lower a quantity strictly below the current one, cancel a line, and
  the last line is never offered (the contract's 409: cancel the order instead); refund
  (`support`, `MoneyField` capped at captured − refunded-or-pending, the store's
  `support_refund_limit_minor` stated as the per-refund ceiling, reason enum, payment picker when
  more than one capture); request return (`support`, per-line quantity ≤ shipped − returned);
  fulfil = plan a shipment (`operations` on HQ: warehouse from `listWarehouses`, per-line quantity
  ≤ fulfillable, carrier/service); per shipment pick, pack (parcel count) and update
  (status/tracking); receive a return (warehouse + condition per item).
- **Pick lists** `/{storeId}/orders/pick-lists` (`operations`): shipments waiting to be picked or
  packed grouped by warehouse, filters by warehouse and status, Pick/Pack from the row. Without
  the relation the page names it (`ForbiddenPanel`) rather than 403-ing from the API.
- **Refund idempotency**: `idempotencyKeyHolder` mints one `Idempotency-Key` per attempt and keeps
  it across failures (network, 5xx, 409), minting a new one only after a success — so a request
  that timed out after the provider acted cannot refund twice on retry. The server action refuses
  a key the contract would (min 8 chars) before building a request.
- **Wrappers** in `src/lib/api/admin.ts` for all thirteen order/fulfilment operations; Zod schemas
  for the inline request bodies in `src/lib/forms/schemas.ts`.
- **Tests**: `orders-helpers.test.ts` (quantities, ceiling, key holder, timeline order, the
  permission table for all seven roles + unassigned), `orders-screens.test.tsx` (money in locale,
  gating per permission set, every confirmation, the retry-reuses-the-key proof, the 403 panel,
  ceiling cap, line-edit guards, pick/pack/receive), `test-contract/orders.test.tsx` (every
  wrapper against Prism, the actions, and the documented 401/403/409 examples on the order
  operations). Test keys are words. e2e: list → detail, and the refund asks first.

### Changed — the four rail nits (2.2 step 0, canonical list in Memory-4-admin)

- **R1** keyboard focus lifts a serpent exactly like hover (the brief: "hover / focus"); only the
  pointer did. **R2** a `prefers-reduced-motion` change while the page is open now switches to the
  list at once (and back); the query was read once at mount. **R3** the SVG no longer carries a
  second named group inside the named `<nav>` — one landmark, the buttons carry the names. **R4**
  the frame loop no longer runs six `querySelector`s per serpent per frame (parts cached per group)
  and the motes canvas pauses with the serpents when the tab is hidden. Each has a regression test.

### Fixed — REQUEST #251: `AdminResponse` maps `202` bodies

- `SuccessBody` in `src/lib/api/admin-client.ts` mapped `200`, then `201`, then fell through to
  `null`, so an operation answering `202` with a body typed as `null` — silently, because the
  fall-through is a valid type. `materializeSegment` (window 17's, answers with the queued
  `Segment`) was the live case; `eraseCustomer` (window 13, Phase 3) answers `202` with no body
  and still types as `null`. Order is 200 → 201 → 202 → `null`, so nothing that resolved before
  changes. A type-level test pins all four cases. Window 17 can drop its cast.

### Added — task 2.1b, issue #192: the Medusa rail and the dark design system

- **The sidebar is gone; the rail is the navigation.** `src/components/rail/MedusaRail` draws the
  head artwork (`public/medusa-face.jpg`, 117 KB, feathered with an SVG mask) and one procedural
  SVG serpent per section the principal may see, its label at the serpent's tip. The items are the
  same permission-filtered `hqNavItems` / `storeNavItems` the old sidebar received — a section the
  user lacks never grows a serpent, and the HQ/Store scope switch appears only when both scopes
  have sections. Nothing new is fetched and nothing here decides access.
- **Motion, as specified in `docs/admin-design.md`:** a load sequence once per session (the head
  surfaces, then each serpent draws itself out of the crown, 1.1 s, staggered 160 ms), a 7 s
  breathing on the head, an independent two-sine sway per serpent (≤ 9 px), hover/focus lift with
  a thicker body, pulsing gold eye and tongue flick, a gaze toward the pointer, and teal motes on a
  canvas. One `requestAnimationFrame` loop writes attributes directly (no React re-render per
  frame) and pauses while the tab is hidden. Every number is in `rail.config.ts`; every position
  comes from `serpent-geometry.ts`, pure arithmetic with no `getTotalLength`, so the same code runs
  in jsdom.
- **Accessibility and fallbacks:** each serpent is `role="button"` with `tabindex`, `aria-pressed`
  and a visible focus ring at the label; Enter and Space navigate. The list view (`RailList`, plain
  links with `aria-current`) replaces the serpents under `prefers-reduced-motion` (toggle locked
  on, no animation set up, no intro flag consumed), by default on touch devices (`hover: none`),
  or by the persisted toggle (`localStorage` `medusa-list`). Under 860 px the rail becomes a
  520 px band above the content. axe passes on both views (`test/rail.test.tsx`).
- **Tokens:** the brief's dark set replaces the light theme in `globals.css` — the only file that
  names a colour or a font. Existing primitives (Button, Badge, Card, DataTable, fields, state
  panels) restyle through the semantic names they already used; `gold` exists for serpent eyes
  only and is never used for text. Measured contrast is recorded next to the tokens.
- **Fonts committed, not fetched:** Cinzel, IBM Plex Sans and IBM Plex Mono as latin woff2 under
  `public/fonts` (OFL licences alongside), loaded with `next/font/local` so no build needs the
  network and no page loads a third-party script.
- **Tests:** `serpent-geometry.test.ts` (roots inside the head, even spacing, stillness at rest,
  sway ≤ the brief, tangent-aligned heads, arc length); `rail.test.tsx` with the 1.7 role fixtures
  (store_staff → no Settings serpent, analyst → no Customers, store_admin → no Finance and no HQ
  scope), scope switch, keyboard, persistence, reduced motion, the once-per-session sequence and
  axe. `shell.test.tsx` now covers `RailList`. e2e: `rail.spec.ts` (serpent buttons, keyboard,
  asset size and no third-party scripts, reduced motion, persistence, HQ scope with `E2E_API=core`)
  and the store-admin journey asserts buttons instead of links.
- Heads sit at most 120 units apart and the block is centred, so two HQ sections sit near the
  head rather than at the far ends of the column; seven store sections still fill it.
- Nit from the manager: `src/lib/api/admin.ts` no longer claims Admin API 0.2.0.
- **Known gap:** `E2E_API=core` could not be re-run — the core does not boot from `main` (#202,
  window 9's job file under Medusa's auto-loaded `src/jobs`). The HQ-scope screenshot was rendered
  against a Prism copy whose `/admin/me` example is the seeded `finance` principal (documented in
  the README); the core variant is re-run when #202 lands.

### Changed — Admin API 0.4.0: the catalog refusal tests drive the spec's own examples

- CONTRACT CHANGE #180 landed in 0.4.0: every operation now documents `401` and `403`, so
  `test-contract/catalog.test.tsx` no longer records "Prism answers normally" for a refused
  `updateProduct`. It asks Prism for the documented `403` and `401` and proves each arrives as an
  `ActionResult` refusal with no field error — the shape `ActionRefusal` renders as the panel.
- Version comments and the README/CLAUDE.md contract line say 0.4.0.

### Added — task 2.1, issue #113 (Admin API 0.3.0, no contract change)

- **A refused mutation renders the state panel, never a silent no-op.** `ActionResult`'s error
  variant now carries `refusal: { status, error }` for 401/403 (set by `toActionResult`), and the
  new `ActionRefusal` component renders `ApiStatePanel` from it — the same "you need `store_staff`
  on `store:…`" panel a screen shows when it cannot load. The product form, publish controls,
  variants panel and categories panel all use it; a 400 still lands under the field it names.
- **Publish asks first.** It emits `product.published` and is the moment a product becomes visible
  to shoppers, so it gets the same inline confirmation archive already had. Both render what the
  server returned (`status`, `published_at`), never an assumed outcome.
- **Media rows can be reordered** (move up / move down, thumbnail is row 1). `position` is no
  longer set by the form at all: the server action renumbers from the array order (REQUEST #68),
  so a number set client-side was only a second source of truth. Still URL-based until window 9's
  Cloudinary pipeline (CONTRACT CHANGE #168).
- **Category picker fix.** "— none —" is `value=""`, which is neither a uuid nor `null`, so the
  schema rejected every submit with no category — and because the field had no error slot, Save
  simply did nothing. It now sends `null`, and every product field shows its own error.
- **Contract tests** (`test-contract/catalog.test.tsx`, 14 tests): every catalog wrapper against
  Prism with `--errors`; the spec's own 400 and 409 examples mapped through `toActionResult` and
  rendered under the Handle input, wired through `aria-describedby`; and the screens driven through
  the _real_ server actions — list rows link to their product, detail shows status and offers the
  five missing variants, the Publish click is a real `POST …/publish`, Create variant gets its 201,
  creating a category resets the form. Prism is spawned per suite on its own port (`prism.ts`).
- **CONTRACT CHANGE #180** filed: no catalog operation documents 401/403 although every one carries
  an `x-permission`, so Prism cannot produce a refusal there; the refusal chain is proven on a
  registry operation (`states.test.tsx`) and with synthesized results (`test/catalog-refusals.test.tsx`).
- **e2e** extended: sign in → New product → editor (the id in the URL is the API's, not the
  form's), publishing asks first, media reorder in the editor.
- **Real-core journey** `e2e/catalog-core.spec.ts`, opt-in with `E2E_API=core` against an app
  started with `ADMIN_API_URL=http://localhost:9000`: sign in as `store-admin` → create a product
  with a fresh handle → create its two variants from the matrix → publish (confirmed) → the list
  shows it published. Passed on 2026-09-08 against core 2.2 with a real Keycloak token and OpenFGA
  permissions; screenshots in `docs/real-core-run/`. The sign-in helper moved to `e2e/staff.ts`
  and both journeys share it.
- Unit: 336 (was 304). Contract: 20 (was 6). E2E on the mock: 11 (was 8), plus 1 against the core.

### Changed — REQUEST #154: `playwright.config.ts` honours `E2E_CHANNEL`

- The config no longer pins `channel: 'chrome'`. `infra/ci/run-e2e.sh` decides the browser and
  exports `E2E_CHANNEL`; the config obeys it exactly: `chrome` uses the machine's Chrome, an empty
  but set value means Playwright's bundled chromium, and only an absent variable falls back to
  Chrome locally and chromium on CI. Window 3's conditional, plus the one-word fix from the request
  (`CHANNEL ? { channel } : {}`) so that `''` is not mistaken for a channel name.
- Nothing changes for a local `pnpm --filter @platform/admin e2e` run without the variable. On CI
  the double browser install can now collapse to one (window 5's follow-up).

### Changed — Integration 1: point the app at the real core with `ADMIN_API_URL`

- `env.adminApiUrl` now resolves `ADMIN_API_URL` first, then `MOCK_ADMIN_API_URL`, then
  `MOCK_URLS.admin` from `@platform/contracts` (`http://localhost:4011`). The root `.env.example` has
  defined `ADMIN_API_URL` all along and the app was quietly ignoring it, so a developer who set it
  kept talking to Prism with no sign anything was wrong. The mock variable stays as the fallback, so
  nothing changes for anyone who has not set the new one.
- The resolved value is validated as an absolute http(s) URL and throws naming the offending
  variable, the same bargain `sessionSecret()` makes — a bad base URL otherwise fails deep inside
  `new URL(base + path)` in a message that names neither the variable nor the value.
- `playwright.config.ts` and `vitest.contract.config.ts` now force `ADMIN_API_URL` to the Prism they
  start. Without that, adding the variable would have made every e2e and contract run inherit
  whatever the developer's `.env` pointed at — `ADMIN_API_URL=http://localhost:9000` would have
  silently turned a hermetic suite into a test of the running core.
- `test/env.test.ts`: the resolution order, the empty-string cases, trailing-slash normalisation and
  the validation failures.
- README documents running against the core: which routes it serves today (`/admin/me`,
  `/admin/stores`, `/admin/stores/{id}/products`, users/roles/audit-log), that real staff tokens are
  forwarded unchanged, and that every other screen 404s into `ApiStatePanel` rather than breaking.

### Added — task 1.8, issue #63 (no contract change)

- **Marketing** reserved in both views: HQ gated on `analyst` (owner implies it), Store gated on
  `store_staff` (store_admin implies it), matching `docs/marketing-scope.md`. finance and operations
  see neither, which is what the issue asks.
- A placeholder page each, listing what will live there (Overview, Campaigns, Segments, Feeds,
  Referrals, Reviews, Consent) and pointing at the scope doc. Deliberately self-contained — one file,
  no components of their own, and no API calls, since there is no marketing contract until
  contracts-v0.3 — so window 17 inherits a clean folder in Phase 2.
- Navigation and route-access fixtures updated for all seven seeded roles, and README and CLAUDE.md
  record both folders as reserved.

### Added — task 1.7, issue #30 (Admin API 0.2.0)

- `test/role-access.test.ts`: route access per role fixture, the other half of the navigation
  matrix. `navigation.test.ts` asserts what each role _sees_; this asserts what each role may
  _open_, because a URL can be typed and the two only agree if the section guards and the navigation
  are derived from the same rules. Every section is decided for every one of the seven seeded roles,
  so adding a section without deciding who reaches it fails a test rather than shipping.
- Playwright: the store-admin journey (sign in → switch store → products), plus the store outside
  `stores[]` getting the 403 panel with the switcher intact, an HQ section being refused, and sign-out
  ending the realm session. It is the only test that exercises the real realm, the app's own OIDC
  routes, the encrypted session cookie, the permission-driven navigation and the catalog screen
  together — everything else stubs at least one of them.
- `playwright.config.ts` starts the Prism mock and a production build of the app; Keycloak must
  already be up. It honours `$PORT` (default 3000) like the app does since #68, and derives both
  the base URL and `ADMIN_APP_URL` from it — though the port is not yet free to choose, because
  `admin-app` registers only `http://localhost:3000/*` as a redirect URI (REQUEST #82 asks for
  3200 as well). Documented in CLAUDE.md as #30 asks. CI wiring is REQUEST #80.

### Changed — REQUEST #68 and a media fix

- `start` is now plain `next start`, so the app honours `$PORT` (default 3000). A hard-coded
  `--port` beats `$PORT`, so the container would listen on one port while Docker and Kubernetes
  probed another and the pod would never become ready.
- Added `GET /health`, the other half of the image contract, and excluded it from the middleware's
  matcher — a probe redirected to the sign-in page never reports healthy. It reports only that the
  process is up: a liveness probe that fails when Keycloak or the Admin API is down would get the
  container killed and restarted, which fixes nothing and removes the instance that could still
  serve the error panels.
- **Media positions are renumbered from the array order** before the request is sent. The form
  assigned a position on append and never revisited it, so removing the first of three images sent
  positions 1 and 2 with no 0, and appending afterwards reused a number already in use. The array
  order is what the user actually sees, so it is what goes to the API.

### Added — task 1.6, issue #29 (Admin API 0.2.0)

- One pattern for every way a screen can fail, with `ApiStatePanel` as the single entry point:
  `401` → sign in again (not a retry, which would fail identically); `403` → names the relation and
  the object from `details`; `404` → scoped, saying which store was searched, because the API
  answers "not found in the caller's scope"; network/`5xx` → the only panel with a retry.
- Empty lists are split from errors, and "nothing yet" from "your filter matched nothing" — the
  first wants a create button, the second wants the filter cleared. `DataTable` takes an
  `emptyAction`, and the Stores and Catalog lists pass one.
- `src/app/error.tsx` and `src/app/not-found.tsx`: the router boundaries. The error boundary shows
  only `error.digest` — a server error message may contain whatever the server was holding.
- `/states`: every panel on one page for comparison, development only (`notFound()` in production)
  and built from the same components the real screens use, so it cannot drift from them.
- `pnpm --filter @platform/admin test:contract` — a suite that boots Prism itself and drives it with
  `Prefer: code=403` (and 401, 404, 200), proving a real refusal from the mock travels through
  `adminRequest` and comes out as the panel naming the missing relation. If the contract's documented
  error example stopped carrying `details.relation`, the unit tests would still pass and this would
  not.
- 37 more tests (266 unit + 6 contract): every panel has a heading and a next action, and none logs
  to the console — both asserted rather than assumed.

### Changed

- `tsconfig.json` now includes `test/` and `test-contract/`. The test files had never been
  typechecked.
- A `403` in a list used to render as "Admin API returned 403"; it now renders the panel that names
  the missing relation. The tests asserting the old wording were updated, not worked around.

### Added — task 1.5 review follow-up (#67)

- **Variants are now actually created and edited.** The product page reconciles the option matrix
  against the existing variants and offers only the gap: one button per missing combination, plus an
  explicit "Create all N" that names the count. Existing variants edit inline (SKU, title, price per
  currency) through `updateVariant`.
  Saving options deliberately does **not** create variants — a variant is a sellable thing with its
  own SKU, price and stock, so adding a colour to a live product must not silently POST several of
  them. The copy on the product page said the opposite; it now says what actually happens.
  A bulk create stops at the first refusal rather than pressing on, because a half-created matrix is
  harder to reason about than a stated failure.
- `missingCombinations` / `sameCombination`, pure and separately tested — including the realistic
  case where a value is added to an existing option and exactly the three new rows are offered.
- **Product media** (`ProductInput.media`): an ordered list of image URLs with alt text, the first
  being the thumbnail. URLs are validated, so `front.jpg` is refused before it reaches the API.
- `compactList` for request bodies carrying arrays of objects with optional fields — `compact` is
  shallow, and product media hit the same nesting that variant prices did.

### Fixed

- README claimed no `.env` was required and listed `ADMIN_SESSION_SECRET` as a "dev constant". It is
  mandatory in every environment; the README now leads with copying `.env.example` and generating one.

### Added — task 1.5, issue #28 (Admin API 0.2.0)

- **HQ Stores**: list, create (`/stores/new`) and detail (`/stores/{id}`) with the store record,
  domains, sales channels and API keys. Sub-resources load in parallel and fail independently, so a
  `viewer` still sees the store even though listing API keys needs `store_admin`.
- **The show-once API key**: revealed once with a copy button and a warning, held in component state
  only — never in the URL, storage, or a re-fetch. The list carries `key_prefix` alone.
- **Store Catalog**: products list with the contract's `q` and `status` filters and 0.2.0 sorting;
  create and edit through one form that previews the variant matrix as options are typed; publish and
  archive rendering the `status` and `published_at` the server returned, with archive behind a
  confirmation; and a categories tree assembled from the flat list.
- Typed wrappers for every `registry` and `catalog` operation, and server actions that re-validate
  with the same Zod schema the browser used.
- `variantMatrix` as a pure, separately tested function: options expand as a cross-product, and an
  option with no values yields no variants rather than a partial matrix.
- `compact()` for request payloads: Zod's `key?: T | undefined` versus the contract's exact-optional
  `key?: T` is a real difference on PATCH, where an explicit `undefined` and an omitted key are not
  the same request.

### Changed

- **Sorting is live.** CONTRACT CHANGE #56 was accepted as Admin API 0.2.0, so `listStores` and
  `listProducts` now sort server-side. It stays opt-in per operation (`{ sortable: true }` plus the
  contract's own enum in `sortableColumns`), because only four list operations gained the parameters.
- **`ADMIN_SESSION_SECRET` is required in every environment.** The hard-coded development fallback is
  gone: a constant committed to the repo is a key everyone has, and "dev" is one mis-set `NODE_ENV`
  from production. `.env.example` documents it; `vitest.config.ts` supplies one for tests.
- Dropped the "delete `.next/` before `format:check`" workaround — REQUEST #44 fixed the root ignore
  lists on main.

### Fixed

- Tests for the two untested server paths: the `/api/auth/callback` route (state mismatch is refused
  without redeeming the code, missing verifier, provider error, a rejected exchange, and the success
  path sealing the session and clearing the transient cookies) and the middleware refresh (refreshes
  inside the skew window, updates the current request as well as the response, and starts a clean
  sign-in when the refresh token is spent).
- `docs/memory/Memory-4-admin.md` claimed the OIDC flow had been verified "end to end" headlessly.
  It had not: the run stopped at Keycloak's TOTP enrolment, so no authorization code was ever issued
  and the token exchange was never exercised live. Corrected in place.

### Added — task 1.4, issue #27 (contracts-v0.1)

- `useContractForm(schema, action)` — the one way this app builds a form. React Hook Form + Zod, with
  the same schema validating on the client and re-validating in the server action, so the two cannot
  disagree about what is valid.
- `src/lib/forms/schemas.ts` — Zod mirrors of `StoreInput`, `ProductInput`, `CategoryInput` and
  `VariantInput`. Hand-written because the contract marks nearly every input property optional
  (`POST` and `PATCH` share a schema), so a generated schema would accept an empty create form. A
  `MatchesContract` type assertion fails the build if a field name or value type drifts — verified
  to fire on both a typo'd field and a wrong value type.
- `src/lib/forms/server-errors.ts` — `400 { details: { field } }` and `409 conflict` are attached to
  that input and the first is focused; a field the form does not render is raised to form level with
  its name kept in the message; `403` is rewritten in terms of the missing relation; a transport
  failure says the API is unreachable. Server errors clear on the next submit.
- `src/lib/forms/action-result.ts` — `toActionResult` maps an `ApiResult` to what the form consumes,
  server-side, so the browser never learns the Admin API's error shape.
- `MoneyField` and `src/lib/forms/money.ts` — money edited as **integer minor units**. Typed text is
  parsed by string manipulation, never by multiplying a float (`12.10 * 100` is
  `1209.9999999999998`). Currency-aware decimals (JPY 0, EUR 2, KWD 3), comma accepted as the
  decimal point, group separators rejected rather than guessed at.
- Accessible field chrome: real `<label>`s, `aria-invalid` on the control, hint and error wired
  through `aria-describedby`, and the form-level banner as `role="alert"`.
- 40 more tests (175 total): money parsing and round-tripping, the full server-error mapping, and
  rendered-form behaviour (schema validation blocks a submit, `details.field` shows under the right
  input, an unknown field shows at form level, stale errors clear, optimistic never runs by default).

### Notes

- Optimistic UI is opt-in: `useContractForm` runs its `optimistic` callback only when one is passed.

### Added — task 1.3, issue #26 (contracts-v0.1)

- `DataTable`, the single list primitive: server-driven paging, filtering and sorting on TanStack
  Table (`manual*` everything), column visibility, row selection with a bulk-action slot, and
  loading / empty / error states that render in place of the rows.
- `src/lib/table/query-state.ts` — table state as URL state. Parsed on the server and handed down,
  so the first paint matches the opened link; serialised back with defaults omitted, so the
  unfiltered URL stays clean. Only declared filter keys are kept, so an injected query parameter
  never reaches the Admin API.
- `src/lib/table/selection.ts` — a selection model in which ticking a page never selects the rest of
  the result set. "Select all N matching" is offered only after a full page is ticked and more rows
  exist, and is a separate click; it keeps an exclusion list so individual rows can still be
  unticked. `describeSelection` gives bulk actions unambiguous wording.
- HQ **Stores** list wired to the primitive with columns typed from `AdminComponents['Store']`, so a
  contract rename breaks the build instead of rendering blanks. Create and edit arrive with #28.
- 57 more tests (135 total): query-string round-tripping, the sort cycle, paging and filter resets,
  the selection model, and the rendered table (sorting and pagination push the expected URL, no
  silent select-all, `aria-sort` on headers, column visibility does not touch the URL).

### Notes

- **Sorting is not wired to the server**: no list operation in contracts-v0.1 accepts `sort`/`order`
  (CONTRACT CHANGE #56). `toContractQuery` withholds both unless an operation is declared sortable,
  so we never send a parameter the contract does not define. Enabling it later is two lines per list.
- `@tanstack/react-table` pinned to `^8`: v9 is published as latest but ships a different API
  (`createCoreRowModel`, `TableFeatures`).

### Added — task 1.2, issue #25 (contracts-v0.1)

- Route groups `(hq)` and `(store)/[storeId]`, with all twelve sections reachable: HQ Stores,
  Warehouse, Finance, BI, Roles, Onboarding; Store Catalog, Orders, Customers, Promotions, Content,
  Settings. The screens themselves arrive with their own issues; each placeholder names which one.
- `src/lib/nav/`: navigation as a pure function of the `Principal`. `sections.ts` is the catalogue
  and every entry records the contract operation its gate comes from; `relations.ts` mirrors the
  OpenFGA model in ADR 0002, so `owner` on the organization is `store_admin` everywhere,
  `store_admin` implies `store_staff`, and any organization relation implies store `viewer` —
  while finance stays organization-only.
- Store switcher listing exactly `stores[]`, backed by a server action that re-validates the chosen
  id against the principal before remembering it in the `admin_selected_store` cookie. The cookie is
  a hint only: it is re-validated on every request, so revoked access takes effect on the next page
  load. Switching stores keeps the current section.
- Per-section guards (`HqSectionGuard`, `StoreSectionGuard`) so typing a URL for a section you
  cannot see renders a 403 panel naming the missing relation and object, never a blank page.
- `src/components/states/`: the first cut of the shared 401/403/404/empty pattern that issue #29
  completes — forbidden, store-forbidden, no-access and request-error panels.
- `/` no longer renders a debug dump: it redirects each principal to the first section they may
  actually open, and only an account with no relations at all stops there.
- 55 more tests (78 total): the per-role HQ and store section matrix for all seven seeded fixtures
  plus an unassigned account, relation implication, cookie resolution, landing paths, the rendered
  nav and switcher (Testing Library), and the server action's refusal to remember a foreign store.

### Changed

- `experimental.typedRoutes` turned off: nearly every link is built from a store id at runtime, so
  typed routes could not check them and only added casts.

### Added — task 1.1, issue #24 (contracts-v0.1)

- Next.js 15 App Router application replacing the Phase 0 library scaffold: React 19,
  Tailwind CSS v4 (tokens in `src/app/globals.css`), TanStack Query provider, hand-written UI
  primitives (`cn`, `Button`, `Card`, `Badge`).
- OIDC authorization-code + PKCE (S256) sign-in against the Keycloak staff realm via the public
  `admin-app` client: `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`.
- Session handling: the token set is AES-GCM encrypted into an httpOnly `SameSite=Lax` cookie,
  chunked across `admin_session.N` because Keycloak tokens exceed the 4 KB cookie limit. Tokens
  never reach client components — `src/lib/api/admin.ts` is `server-only`.
- `src/middleware.ts` gates every page and is the single place that refreshes the access token,
  updating both the current request and the response.
- Typed Admin API client over `@platform/contracts/admin`: `AdminResponse<'operationId'>` gives the
  exact contract response body, `buildPath` fills templated paths, and every call resolves to
  `{ ok: true, data } | { ok: false, status, error }` so 401/403/404 render as panels (issue #29).
- `/` renders the `Principal` from `GET /admin/me` (user, organization, relations, stores) as proof
  of the Keycloak → session → Admin API chain; issue #25 replaces it with the real navigation.
- 23 Vitest tests: session sealing and tamper-rejection, cookie chunking and stale-chunk clearing,
  the RFC 7636 PKCE test vector, and Admin API error mapping (401/403/5xx/network).
- `.env.example` documenting every setting and its default.

### Changed

- `package.json` is now an application, not a library: no `main`/`exports`, and `src/index.ts` is
  gone. Scripts are `dev`/`build`/`start`/`typecheck`/`test`.

### Notes

- `jose` was evaluated and dropped: its JWE support pulls `CompressionStream` into the Edge
  middleware bundle. ID-token claims are decoded in `src/lib/auth/jwt.ts` instead — decoding only,
  because the token arrives over TLS straight from the token endpoint and the Admin API is the
  boundary that verifies access tokens.
- `.next/` and `next-env.d.ts` are ignored locally; the root ESLint and Prettier ignore lists do not
  cover Next build output yet (`REQUEST:` issue filed — those files belong to the main window).
