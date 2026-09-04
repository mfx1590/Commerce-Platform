# Changelog — @platform/admin

## Unreleased

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
