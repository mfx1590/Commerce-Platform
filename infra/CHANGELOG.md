# infra — changelog

Window 5 (Infra & DevOps). Owned paths: `infra/**`, `.github/workflows/**`, `**/Dockerfile`.

## Unreleased — Phase 2

### Added

- **App images (issue #31, task 2.1).** `apps/<app>/Dockerfile` for all six app scaffolds (`core`, `admin`,
  `storefront-starter`, `accounting`, `analytics-ingest`, `notifications`): multi-stage build over the pnpm
  workspace, `pnpm --filter <app> --prod --legacy deploy` to a pruned package, `node` user (uid 1000),
  `EXPOSE $PORT` and a `HEALTHCHECK` on `/health`. A scaffold image is ~221 MB (`docker images`): node:20-alpine
  plus a 24 MB global pnpm; the app's own layers are ~100 KB, so the size is all base image until the real apps land.
- `infra/docker/entrypoint.sh` — runs `pnpm start` when the app defines one, otherwise the scaffold health
  server. This is what lets the images build and pass their health check today and keep working unchanged when
  windows 1/3/4 replace the scaffolds with Medusa / Next.js.
- `infra/docker/health-server.mjs` — the scaffold `/health` responder.
- `infra/docker/docker-compose.build.yml` — builds all six images from the repo root; `IMAGE_TAG` selects the tag.
- `infra/docker/smoke-images.sh` — asserts every image starts, runs non-root, and reaches `healthy`.
- CI job `images` in `.github/workflows/ci.yml` — builds all six and runs the smoke test on PRs that touch
  `apps/**`, `packages/**`, `infra/docker/**` or the workspace root files. Never pushes.

- **Terraform for dev + staging (issue #32, task 2.2).** `infra/terraform/` with seven modules — `network`
  (VPC, 3 AZs, NAT, S3 gateway endpoint), `cluster` (EKS, managed node group, IRSA), `postgres` (RDS 16,
  `rds.force_ssl`, Secrets Manager), `redis` (ElastiCache 7, transit encryption), `objects` (S3 media +
  backups), `ci-oidc` (GitHub OIDC, no long-lived keys) and `environment`, which composes them. `envs/dev`
  and `envs/staging` are thin wrappers around `environment`, so both environments are the same shape and
  differ only in size and safety flags. Redpanda stays managed (Redpanda Cloud): connection variables only.
- Environment outputs are named after `.env.example` variables, including the app configuration windows 1,
  3 and 4 added while this was in flight: `DATABASE_URL`, `DATABASE_URL_APP`, `DATABASE_URL_MEDUSA_OWNER`,
  `MEDUSA_DB_SCHEMA`, `REDIS_URL`, `KAFKA_BROKERS`, `KEYCLOAK_URL`, `OPENFGA_API_URL`, `MOCK_API_URL`,
  `MOCK_ADMIN_API_URL`, `STORE_API_URL`, `ADMIN_API_URL`, `STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS`,
  `S3_MEDIA_BUCKET`, `S3_BACKUP_BUCKET`, plus a `dotenv` output that renders the whole file.
- `JWT_SECRET`, `COOKIE_SECRET` and `ADMIN_SESSION_SECRET` are generated with `random_password` and stored in
  Secrets Manager, never typed. `.env.example` carries obvious dev placeholders for them; a cloud environment
  must not. `CORE_DEV_TOKENS`, `CORE_ORGANIZATION_ID`, `STORE_PUBLISHABLE_KEY` and `PORT` are deliberately not
  emitted, and the `dotenv` output says why next to each.
- The `medusa_owner` role (`apps/core/CLAUDE.md`: owns schema `medusa`, needs CREATE on the database, is never
  the runtime connection) gets its own generated password, its own Secrets Manager entry and its own branch in
  the bootstrap Job, alongside `platform_app`.
- `infra/kubernetes/bootstrap-db/` — Job + idempotent SQL that creates the `platform_app` role with the
  Terraform-generated password before the migrations run, so the local-development password in
  `packages/db/migrations/0001_app_schema.sql` never reaches a cloud environment. Refuses to leave the role
  SUPERUSER or BYPASSRLS.
- `infra/terraform/check.sh` — `fmt -check` + `init -backend=false` + `validate` for both envs, with no AWS
  account. Uses a local `terraform` when present, otherwise the official Docker image.
- CI job `terraform` in `.github/workflows/ci.yml` — runs `check.sh` on PRs touching `infra/terraform/**`.
- `infra/README.md` — Terraform layout, the secrets/state rules, and a runbook from an empty AWS account
  through dev to staging, with literal commands.

### Fixed

- **The app images build and carry their build output again (issue #59).** Three separate defects, all found
  by building and running the images rather than by reading them:
  1. `pnpm --filter <app> build` does not build the app's workspace dependencies, so `apps/core` compiled
     against `@platform/db` with no `dist/`. Every Dockerfile now runs `pnpm --filter <app>... build`.
  2. `medusa build` cannot load `medusa-config.ts` without `ts-node`, which `apps/core` does not declare —
     `pnpm --filter @platform/core build` fails the same way on a laptop and in CI, not just in Docker. The
     build stage installs it globally until [REQUEST #60](https://github.com/mfx1590/Commerce-Platform/issues/60)
     lands; it never reaches the runtime image. The stage also sets placeholder values for the variables
     `medusa-config.ts` requires, because an image build has no `.env` and the config throws without them.
  3. `pnpm deploy` packs the package the way npm does and skips dot-directories, so `.medusa/server` and
     `.next` — the entire output of `medusa build` and `next build` — were dropped from all three real app
     images. Each Dockerfile now copies its build output across explicitly and asserts it is there.
- `continue-on-error` removed from the CI `images` job: it is a required check again.

### Changed

- `infra/docker/smoke-images.sh` now decides per image what to check, from the deployed `package.json`:
  a scaffold must reach `healthy` and answer `/health`; a real app must run as non-root and carry its build
  output. Real apps are deliberately not booted — `apps/core` and `apps/admin` both refuse to start without a
  database or secrets, which is correct behaviour, and proving a configured app serves traffic belongs to the
  staging deploy. The new check is what caught defect 3 above in `admin` and `storefront-starter`.
- The admin and storefront images use `PORT` 3000 and 3100 to match the `--port` their `start` scripts
  hard-code, so the `HEALTHCHECK` probes the port the app actually listens on
  ([REQUEST #68](https://github.com/mfx1590/Commerce-Platform/issues/68) asks for `$PORT` to be honoured).
- `infra/README.md` "Image contract" now lists what an app must provide for its image to build, with the
  reason behind each entry.

### Added (task 2.4a — CI caching and path filters, issue #34)

- `infra/ci/changes.sh` + `changes.test.sh` — one classifier deciding which job groups a change
  needs (`code`, `images`, `terraform`), with an 18-case self-test the `changes` job runs before
  trusting it. Replaces the two inline `git diff` filters tasks 2.1 and 2.2 each added to their own job.
- `infra/docker/docker-bake.hcl` — GitHub Actions build cache (`type=gha`, one scope per image,
  `mode=max`) layered on top of `docker-compose.build.yml`, which stays the single source of truth for
  what gets built. CI drives it with `docker/bake-action`, because the cache backend needs
  `ACTIONS_RUNTIME_TOKEN` / `ACTIONS_CACHE_URL`, which GitHub gives to an action but not to a `run:` step.
  `docker compose build` locally is unchanged.
- turbo task-output cache (`actions/cache` on `.turbo`) in `lint-typecheck`, `unit` and `contract`;
  `actions/setup-node` was already caching the pnpm store.

### Changed

- **Every Dockerfile installs dependencies before it sees a source file.** A `manifests` stage collects
  the `package.json` files and the lockfile with `find`; a `deps` stage copies only those and runs
  `pnpm install`; sources arrive after. Previously `COPY apps ./apps` came first, so any source change
  invalidated the install layer and no build cache could help. Verified locally: after touching an app
  source file, `pnpm install --frozen-lockfile` reports `CACHED`.
  Collecting the manifests with `find` rather than one `COPY apps/<name>/package.json` line per package
  means a new workspace package needs no Dockerfile edit.
- CI jobs always run and skip their expensive steps, rather than being skipped by a job-level `if`:
  a skipped job reports a different conclusion to branch protection than a successful one.
- `infra/terraform/.gitignore` ignores `backend.hcl` by name. The `*.tfvars` rules did not cover it, so a
  developer's backend configuration — which names the state bucket and lock table — could have been
  committed. The two `backend.hcl.example` files said otherwise; they now say what is true.
- The bootstrap Job passes database credentials **only** through the environment; `bootstrap.sql` reads
  them with `\getenv`. They used to be `--set=` arguments, and container argv is readable with `ps` from
  inside the pod.

### Notes

- `scripts/check-ownership.sh` is unchanged and remains the first CI job (owned by the main window).
- Nothing has been applied to a real AWS account. Task 2.2 stops at `terraform validate`, as agreed, until the
  owner provides credentials; `plan`/`apply` are runbook steps.
