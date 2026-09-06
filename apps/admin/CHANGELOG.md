# Changelog — @platform/admin

## Unreleased

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
