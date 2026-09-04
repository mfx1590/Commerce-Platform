# infra

- `docker/` — local stack (`pnpm dev`): Postgres, Redis, Redpanda, Keycloak, OpenFGA, mock API. Main window.
- `keycloak/` — realm exports (staff, customers). Window 2.
- `openfga/` — authorization model (`model.fga`) and seed tuples. Window 2.
- `redpanda/` — topic definitions and schema registry config. Window 14.
- `terraform/` — AWS dev/staging (Phase 2). Window 5.
