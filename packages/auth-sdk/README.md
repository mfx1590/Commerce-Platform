# @platform/auth-sdk

Server-side authorization helpers: Keycloak JWT verification, OpenFGA check/list helpers, request scope resolution (which stores may this principal act on), and the requirePermission guard every mutating route must call.

See CLAUDE.md for run/test commands and the public API. Owner: window 2 (auth).

## Related infrastructure (same owner)

- `infra/keycloak/` — realm exports (`staff` with mandatory TOTP, `customers` per brand) and how to change them.
- `infra/openfga/` — authorization model and seed tuples (task 1.2).

## Tests

`pnpm --filter @platform/auth-sdk test`. Tests that need the docker stack (`pnpm dev`) skip themselves when
the service does not answer: Keycloak at `KEYCLOAK_URL` (default `http://localhost:8180`).
