# Changelog — @platform/admin

## Unreleased

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
