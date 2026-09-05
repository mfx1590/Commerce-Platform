# @platform/auth-sdk

Server-side authorization helpers: Keycloak JWT verification, OpenFGA check/list helpers, request scope resolution (which stores may this principal act on), and the requirePermission guard every mutating route must call.

See CLAUDE.md for run/test commands and the public API. Owner: window 2 (auth).

## Related infrastructure (same owner)

- `infra/keycloak/` — realm exports (`staff` with mandatory TOTP, `customers` per brand) and how to change them.
- `infra/openfga/` — authorization model and seed tuples (task 1.2).

## Tests

`pnpm --filter @platform/auth-sdk test`. Tests that need the docker stack (`pnpm dev`) skip themselves when
the service does not answer: Keycloak at `KEYCLOAK_URL` (default `http://localhost:8180`).

## OpenFGA helpers (task 1.2)

```ts
import { createOpenFgaClient, seedOpenFga, loadAuthorizationModel } from '@platform/auth-sdk';
const client = createOpenFgaClient(); // OPENFGA_API_URL / OPENFGA_STORE_ID / OPENFGA_MODEL_ID from env
await client.check({
  user: 'user:<staff_user.id>',
  relation: 'finance',
  object: 'organization:hq',
});
```

- Ids: `user:<staff_user.id>`, `organization:hq`, `store:<store.id>` (see `infra/openfga/README.md`).
- `pnpm --filter @platform/auth-sdk fga:seed` bootstraps the local store and writes the ids to `.env`.
- OpenFGA tests use a throw-away store per run (`OPENFGA_API_URL`, default `http://localhost:8081`) and skip
  when the server is down.
