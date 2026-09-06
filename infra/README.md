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
  | `commerce-platform/admin`              | `apps/admin/Dockerfile`              | 3000             | 4          |
  | `commerce-platform/storefront-starter` | `apps/storefront-starter/Dockerfile` | 3100             | 3          |
  | `commerce-platform/accounting`         | `apps/accounting/Dockerfile`         | 9003             | 15         |
  | `commerce-platform/analytics-ingest`   | `apps/analytics-ingest/Dockerfile`   | 9004             | 12         |
  | `commerce-platform/notifications`      | `apps/notifications/Dockerfile`      | 9005             | 16         |

  These are container ports. The build compose publishes none, and the smoke script maps each one to the same
  number on the host — free on this machine (other projects own 5432/6379/6380/8080; ours are 5433/6381/8180/8081/19092/4010/4011).
  The two Next.js apps sit at 3000/3100 rather than in the 900x block because their `start` scripts hard-code
  `next start --port 3000` / `--port 3100`, which overrides `$PORT`; the image follows the app so that its
  `HEALTHCHECK` probes the port the app really listens on. [REQUEST #68](https://github.com/mfx1590/Commerce-Platform/issues/68)
  asks windows 3 and 4 to drop the flag, after which both images move back to 9001/9002.

  **Image contract with the app windows** (a change needs a `CONTRACT CHANGE:` issue):

  1. Build context is the repo root. The Dockerfile runs `pnpm install --frozen-lockfile`, then
     `pnpm --filter <app>... build` — the `...` suffix builds the app **and its workspace dependencies**
     (`@platform/db`, `@platform/events`, `@platform/contracts`) in topological order — then
     `pnpm --filter <app> --prod --legacy deploy /out` to get a pruned, self-contained package.
  2. The container starts `pnpm start` inside that package. **Adding a `start` script to an app is the only
     change needed** to switch its image from scaffold to the real app. Until then, `docker/entrypoint.sh` runs
     `docker/health-server.mjs`, so the `HEALTHCHECK` is real either way.
  3. The app must listen on `$PORT` and answer `GET /health` with 200. Every image runs as the non-root `node`
     user (uid 1000) and ships no build toolchain beyond node + pnpm.

  **What an app must provide for its image to build.** Everything below is something that actually broke a
  build; check it when adding an app or changing a build:

  | requirement                                                                | why                                                                                                                                                                                                                                                                                                                                                                       |
  | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Every tool the `build` script invokes is a declared dependency of that app | The image installs the workspace from the lockfile and nothing else. A tool that happens to be on your machine, or that a framework CLI `require()`s by name, will not be there. `apps/core` needs `ts-node` for `medusa build`, which is [REQUEST #60](https://github.com/mfx1590/Commerce-Platform/issues/60); the Dockerfile installs it in the build stage meanwhile. |
  | Dev dependencies are available at build time                               | The image installs the full workspace and only prunes with `--prod` afterwards, when producing the deployed package.                                                                                                                                                                                                                                                      |
  | Config files the build reads live inside the app directory                 | The build stage copies `apps/` and `packages/` from the repo root. `apps/core/medusa-config.ts` is copied; a file outside the workspace is not.                                                                                                                                                                                                                           |
  | The build must not need real infrastructure or secrets                     | There is no database, cache or `.env` during an image build. If a config file throws on a missing variable — as `medusa-config.ts` does for `DATABASE_URL_APP`, `REDIS_URL`, `JWT_SECRET`, `COOKIE_SECRET` — the Dockerfile sets syntactically valid placeholders for the build stage only. Nothing connects anywhere and no placeholder is baked into the output.        |
  | Build output in a dot-directory needs an explicit copy                     | `pnpm deploy` packs the package the way npm would, and npm's rules skip dot-directories. `medusa build` writes everything to `.medusa/server`, so `apps/core/Dockerfile` copies it across after the deploy step. An app that builds to `dist/` needs nothing extra.                                                                                                       |
  | `start` must run from the package root                                     | The entrypoint runs `pnpm start` with the working directory at the deployed package, so a path like `node .medusa/server/src/server.js` resolves.                                                                                                                                                                                                                         |

  **What the smoke test does and does not prove.** `infra/docker/smoke-images.sh` checks that every image
  starts, runs as a non-root user, and execs what it should. For a scaffold that means the `HEALTHCHECK`
  reaches `healthy` and `/health` returns 200. For a real app — `apps/core` today — it means `pnpm start`
  runs and the process stays up; it is deliberately **not** health-checked there, because a real app needs a
  migrated database, a cache and secrets, and standing those up is a deployment concern. That end-to-end check
  belongs to the staging deploy (tasks 2.3/2.4). The test still catches the failure that matters: if the build
  output is missing from the deployed package, `pnpm start` exits at once and the container is not running.

  CI job `images` in `.github/workflows/ci.yml` builds all six on PRs that touch `apps/**`, `packages/**`,
  `infra/docker/**` or the workspace root files, runs the smoke test, and never pushes.

- `keycloak/` — realm exports. Phase 0 ships local-dev stubs (7 staff users, one customer); window 2 replaces them (MFA, SSO, mappers).
- `openfga/` — authorization model (`model.fga`) and seed tuples. Window 2 (the frozen relation names are in docs/adr/0002-auth-model.md).
- `redpanda/` — topic definitions and schema registry config. Window 14.
- `terraform/` — AWS dev/staging (Phase 2). Window 5.
