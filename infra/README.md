# infra

- `docker/docker-compose.yml` — local stack for `pnpm dev` (main window). Host ports chosen to avoid clashes with other projects:

  | service | host port | notes |
  |---|---|---|
  | postgres | 5433 | `platform/platform`, db `platform`; app role `platform_app` |
  | redis | 6381 | |
  | redpanda | 19092 (Kafka), 18081 (schema registry), 18082 (HTTP proxy), 9644 (admin) | |
  | keycloak | 8180 | admin/admin; realms `staff`, `customers` imported from `keycloak/*.json` (dev-mem, re-imported on every start) |
  | openfga | 8081 (HTTP), 8082 (gRPC), 3001 (playground) | memory datastore |
  | mock-store / mock-admin | 4010 / 4011 | Prism on `packages/contracts/openapi/*.yaml` |

  `pnpm dev --down` stops, `pnpm dev --reset` also wipes volumes.
- `keycloak/` — realm exports. Phase 0 ships local-dev stubs (7 staff users, one customer); window 2 replaces them (MFA, SSO, mappers).
- `openfga/` — authorization model (`model.fga`) and seed tuples. Window 2 (the frozen relation names are in docs/adr/0002-auth-model.md).
- `redpanda/` — topic definitions and schema registry config. Window 14.
- `terraform/` — AWS dev/staging (Phase 2). Window 5.
