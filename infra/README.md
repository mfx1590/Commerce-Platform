# infra

- `docker/docker-compose.yml` — local stack for `pnpm dev` (main window). Host ports chosen to avoid clashes with other projects:

  | service                 | host port                                                                | notes                                                                                                                                                              |
  | ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | postgres                | 5433                                                                     | `platform/platform`, db `platform`; app role `platform_app`                                                                                                        |
  | redis                   | 6381                                                                     |                                                                                                                                                                    |
  | redpanda                | 19092 (Kafka), 18081 (schema registry), 18082 (HTTP proxy), 9644 (admin) |                                                                                                                                                                    |
  | keycloak                | 8180                                                                     | admin/admin; realms `staff`, `customers` imported from `keycloak/*.json` on first start, persisted in the `keycloak-data` volume (`pnpm dev --reset` to re-import) |
  | openfga                 | 8081 (HTTP), 8082 (gRPC), 3001 (playground)                              | memory datastore                                                                                                                                                   |
  | mock-store / mock-admin | 4010 / 4011                                                              | Prism on `packages/contracts/openapi/*.yaml`                                                                                                                       |

  `pnpm dev --down` stops, `pnpm dev --reset` also wipes volumes.

- `docker/docker-compose.build.yml` — build-only compose that produces one image per app. It starts nothing and publishes no ports.

  ```bash
  docker compose -f infra/docker/docker-compose.build.yml build           # all six
  docker compose -f infra/docker/docker-compose.build.yml build core      # one
  IMAGE_TAG=$(git rev-parse --short HEAD) docker compose -f infra/docker/docker-compose.build.yml build
  bash infra/docker/smoke-images.sh                                       # non-root + /health check
  ```

  | image                                  | Dockerfile                           | container `PORT` | app window |
  | -------------------------------------- | ------------------------------------ | ---------------- | ---------- |
  | `commerce-platform/core`               | `apps/core/Dockerfile`               | 9000             | 1          |
  | `commerce-platform/admin`              | `apps/admin/Dockerfile`              | 9001             | 4          |
  | `commerce-platform/storefront-starter` | `apps/storefront-starter/Dockerfile` | 9002             | 3          |
  | `commerce-platform/accounting`         | `apps/accounting/Dockerfile`         | 9003             | 15         |
  | `commerce-platform/analytics-ingest`   | `apps/analytics-ingest/Dockerfile`   | 9004             | 12         |
  | `commerce-platform/notifications`      | `apps/notifications/Dockerfile`      | 9005             | 16         |

  These are container ports. The build compose publishes none, and the smoke script maps each one to the same
  number on the host — free on this machine (other projects own 5432/6379/6380/8080; ours are 5433/6381/8180/8081/19092/4010/4011).

  **Image contract with the app windows** (a change needs a `CONTRACT CHANGE:` issue):

  1. Build context is the repo root; the Dockerfile runs `pnpm install --frozen-lockfile`, then
     `pnpm --filter <app> build`, then `pnpm --filter <app> --prod --legacy deploy /out` to get a pruned,
     self-contained package.
  2. The container starts `pnpm start` inside that package. **Adding a `start` script to an app is the only
     change needed** to switch its image from scaffold to the real app (Medusa for core, `next start` for
     admin/storefront, the worker entrypoint for accounting/analytics-ingest/notifications). The infra window
     does not have to touch the Dockerfile again.
  3. Until an app has a `start` script, `docker/entrypoint.sh` runs `docker/health-server.mjs` instead, so the
     image `HEALTHCHECK` is real today and stays real afterwards.
  4. The app must listen on `$PORT` and answer `GET /health` with 200. Every image runs as the non-root `node`
     user (uid 1000) and ships no build toolchain beyond node + pnpm (~53 MB for a scaffold).

  CI job `images` in `.github/workflows/ci.yml` builds all six on PRs that touch `apps/**`, `packages/**`,
  `infra/docker/**` or the workspace root files, runs the smoke test, and never pushes.

- `keycloak/` — realm exports. Phase 0 ships local-dev stubs (7 staff users, one customer); window 2 replaces them (MFA, SSO, mappers).
- `openfga/` — authorization model (`model.fga`) and seed tuples. Window 2 (the frozen relation names are in docs/adr/0002-auth-model.md).
- `redpanda/` — topic definitions and schema registry config. Window 14.
- `terraform/` — AWS dev/staging (Phase 2). Window 5.
