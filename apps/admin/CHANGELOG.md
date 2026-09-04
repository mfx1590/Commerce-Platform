# Changelog — @platform/admin

## Unreleased

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
