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

### Added (issue #80 — live auth + end-to-end CI job)

- CI job `auth-e2e`: boots Keycloak (both realms imported from `infra/keycloak`), OpenFGA and Postgres from
  `infra/docker/docker-compose.yml` — `services:` containers cannot mount a repository directory, which is why
  it is compose — then runs the live auth suites and every Playwright journey.
- `infra/ci/wait-for-auth-stack.sh` — fails the job if any of those services is not up. The live suites are
  `describe.runIf(await reachable())`, so without this a mis-wired URL would produce a green job that asserted
  nothing.
- `infra/ci/run-e2e.sh` — runs every `apps/*/playwright.config.*` it finds, so a new journey is picked up
  without a workflow change, and fails if it finds none. `ADMIN_E2E_PORT` defaults to 3200 (registered by
  REQUEST #82, now merged) and `ADMIN_APP_URL` is exported to match, so Keycloak's callback lands on the app.
  The browser is Playwright's chromium on CI and the machine's Chrome locally — except where a config still
  pins `channel: 'chrome'`, which forces the Chrome channel; REQUEST #84 removes that and the script switches
  by itself.
- The classifier grew an `e2e` group, and `infra/ci/**` now counts towards `images` and `e2e` — those scripts
  are the pipeline, so a change to them has to be exercised by the jobs that use them.

### Fixed

- `infra/ci/run-e2e.sh` builds each app's workspace dependencies with turbo before running its journey.
  A playwright config's `webServer` builds the app but not the packages it imports, so on a clean runner the
  storefront build failed with "Can't resolve '@platform/ui'". `--filter='<pkg>^...'` builds the dependencies
  and leaves the app to its own config.
- `infra/ci/check-image-manifests.sh` discovered workspace packages with `find ... -name package.json`, which
  also matched build output (`apps/storefront-starter/.next/package.json` is written by `next build`) and
  failed on any machine that had run a build. It now asks `pnpm -r list`.

### Changed (runner-minute budget)

- On a pull request the `images` group now fires only for things that define **how** an image is built — a
  `Dockerfile`, `.dockerignore`, `infra/docker/**`, `infra/ci/**` or a workspace-root manifest — and no longer
  for every change under `apps/**` or `packages/**`. A push to `main` still builds everything, so an app change
  that breaks its own image is caught at merge. Rebuilding six images on every push was ~10 minutes of runner
  time each time and exhausted the month's budget. The self-test covers both directions.

### Added (task 2.3 — Helm charts and ArgoCD, issue #33)

- `infra/helm/platform-app` — **one** chart for core, admin, storefront and both Prism mocks. They are the
  same shape (a stateless container serving `$PORT` with a health path), so five charts would only give five
  places to drift; ten values files under `infra/helm/values/<app>/values-<env>.yaml` carry what differs.
  Deployment with startup/readiness/liveness probes, Service, Ingress, ServiceAccount (IRSA-ready),
  ExternalSecret and an optional HPA.
- The chart refuses to render without an image repository, tag or ingress host, and rejects the tag `latest`:
  ArgoCD syncs a tag, so a moving tag means the cluster and the repository disagree about what is running.
- `infra/argocd` — the `AppProject` (which lists sources, destinations and permitted kinds explicitly rather
  than `*`, because an app-of-apps otherwise puts unrestricted cluster access one commit away), the
  app-of-apps, and ten `Application` manifests. dev self-syncs; staging is synced by the deploy workflow, so a
  release is deliberate.
- `infra/helm/check.sh` — `helm lint`, `helm template` for all ten app/environment combinations, and
  `kubeconform -strict` over every rendered manifest plus `infra/argocd`. Local binaries when present,
  official images through Docker otherwise, same as `infra/terraform/check.sh`. kubeconform is given the CRD
  catalogue so `ExternalSecret` and `Application` are actually validated rather than skipped as
  "missing schema".
- CI job `helm`, and a `helm` group in the classifier so chart changes re-check only what they affect.

### Fixed

- The chart passes the image tag through `toString`. A git sha can be forty digits with no letters, which YAML
  reads as a number, and comparing it to a string failed the render with "incompatible types for comparison" —
  found by `helm lint` against a placeholder tag of all zeroes, which is exactly the case that would have
  reached a real deploy.

### Fixed (review of #95)

- The Prism mock probes could never have passed. Every path Prism serves answers 401 without credentials and
  Kubernetes counts only 200-399 as success, so readiness would have stayed red and liveness would have
  restarted a healthy pod. The mocks now use a `tcpSocket` probe, and their ALB annotation carries
  `success-codes: '200-399,401,404'` because an ALB target group has no TCP health check. The chart gained
  `service.probe`, validated to be `httpGet` or `tcpSocket`, and all three probes render from one helper so
  they cannot drift.
- No application configuration reached the pods: `env:` was empty everywhere, so admin and storefront would
  have fallen back to their localhost defaults — inside a pod, themselves. All ten values files now carry the
  non-secret half of `.env.example` (`KEYCLOAK_URL`, `KEYCLOAK_REALM_*`, `OPENFGA_API_URL`, `OPENFGA_STORE_ID`,
  `MEDUSA_DB_SCHEMA`, `CORE_ORGANIZATION_ID`, the three CORS vars, `STORE_API_URL`, `ADMIN_API_URL`,
  `ADMIN_APP_URL`, `STORE_PUBLISHABLE_KEY`, `S3_MEDIA_BUCKET`), using the same substituted-at-deploy hostname
  placeholder as `ingress.host`. Secrets still come only from the ExternalSecret.
- `stoplight/prism:5` was a moving tag — the exact failure the chart's `latest` guard exists to prevent. Both
  mock values files pin `sha256:3f6d29e…`, and the chart supports `image.digest` (validated to start
  `sha256:`) alongside `image.tag` for our own git-sha-tagged images.

### Added (task 2.4b — deploy-staging and branch protection, issue #34)

- `.github/workflows/deploy-staging.yml` — builds the three app images from the merged commit with the same
  bake definition CI uses, pushes them to ECR under the git sha, then points each staging Application at that
  tag and syncs it. `argocd app wait --health` means the job is green only once the pods are up, which for core
  includes its migration hook having succeeded. The image tag is the only thing it changes.
  Until the five settings exist it is a **no-op that names what is missing and exits 0** — a deploy workflow
  that goes red on every push to main teaches people to ignore a red main.
- Branch-protection documentation: the nine required checks by job name, why every job always runs (a job
  skipped by a job-level `if:` reports a conclusion branch protection treats differently from success), and why
  the end-to-end job is required while the preview placeholder is not.

### Fixed (follow-ups from the #95 review)

- **Migrations were a manual runbook step using the owner credential.** They are now an ArgoCD PreSync hook
  Job (`migrations.enabled`, core only) that runs `@platform/db`'s CLI out of _the same image as the app_, so
  the migrations that ship with a release are the ones that run for it. The owner role comes from its own
  ExternalSecret — the application still connects as `platform_app`, because RLS depends on it. A failed
  migration fails the sync instead of letting code roll out against a schema that has not caught up.
- **`checksum/env` claimed to roll pods on a secret rotation and could not.** It hashed only `.Values.env`, and
  Helm never sees a secret value — External Secrets writes it at run time. The annotation is now
  `checksum/config` and is honest about covering configuration in git; the actual rotation path is
  `reloader.stakater.com/auto`, with Reloader added to the bootstrap runbook and
  `kubectl rollout restart` documented as the manual equivalent.

### Fixed

- The classifier treated only `ci.yml` as a workflow. Prettier formats every file under
  `.github/workflows/`, so a change to any other one — `deploy-staging.yml`, added in this task —
  classified as _nothing_, meaning `format:check` never saw it and an unformatted workflow would have landed
  green and then broken `format:check` on somebody else's unrelated PR. Found by watching this PR's own
  `what changed` output. Any workflow file now counts as `code`.

### Fixed (review of #98)

- **The image-tag bump was imperative and the app-of-apps would have undone it.** `argocd app set --helm-set`
  writes `spec.source.helm.parameters` onto the live Application, and the app-of-apps manages those CRs with
  automated sync and `selfHeal` — ArgoCD reconciles them back to git and strips the parameters. Staging would
  have sat permanently OutOfSync against the `0000…` placeholder, and the next Sync would have rolled it onto
  an unpullable image. The workflow now commits `image.repository` **and** `image.tag` into the staging values
  file and then syncs; git stays the source of truth.
- `infra/ci/set-image.mjs` performs that edit by replacing two lines instead of re-emitting the document.
  `yq -i` drops blank lines, and since the deploy commit carries `[skip ci]` nothing would have noticed until
  `format:check` failed on an unrelated PR. It refuses a tag that is not a 40-character git sha, verifies the
  two fields afterwards, and refuses to write if any other line changed. The workflow then renders the chart
  with `infra/helm/check.sh` before the commit reaches main.
- Documented that branch protection cannot be enabled on this repository yet (private, free plan — the API
  returns 403), and that `deploy-staging.yml` will need a bypass allowance for `github-actions[bot]` when it
  can be.

### Added (task 2.5 — observability, issue #35)

- `docker compose --profile observability` adds the OTel collector, Prometheus, Loki, Tempo and Grafana to the
  local stack. `pnpm dev` and a plain `docker compose up` are unchanged — all five carry
  `profiles: ['observability']`, so they cost nothing until asked for.
- Ports chosen against `Get-NetTCPConnection`, not from the defaults: Grafana 3400 (3000 is another project),
  Loki 3410 (3100 is the storefront), Tempo 3420 (3200 is the admin e2e port), Prometheus 9090. The collector
  keeps the OTLP defaults 4317/4318, because every SDK ships pointing at them.
- Apps export OTLP to the collector and know nothing about the backends, so moving traces or logs to Grafana
  Cloud is a change in `otel-collector.yaml` rather than in application code.
- Grafana datasources and the `Commerce platform — overview` dashboard are provisioned from files: request
  rate, error rate and p95 latency per store from Tempo-derived span metrics, and outbox lag from
  `SELECT * FROM app.outbox_lag()` as the read-only `platform_metrics` role (migration 0110) — aggregates
  only, so no event payload can reach a dashboard.
- Trace ⇄ log navigation both ways (`tracesToLogsV2` on Tempo, `derivedFields` on Loki) and exemplars from the
  latency panel into a trace.
- `infra/observability/check.sh` and CI job `observability`: the profile really is off by default, dashboards
  are valid JSON naming datasources that exist, no two services claim a host port, Prometheus parses its
  config. A `observ` group in the classifier so a dashboard edit re-checks only that.
- The OTel setup snippet apps will import, Sentry DSN wiring, and a seven-step runbook for reading a trace end
  to end, all in `infra/README.md`. No application source was touched — `apps/**` belongs to other windows.

### Fixed

- Tempo's span-metrics processor promotes `store_id` and `deployment.environment` as dimensions. Without that
  the generated series carry only `service`, `span_name`, `span_kind` and `status_code`, and **every per-store
  panel renders empty while looking perfectly healthy**. Found by sending a span and reading the label set back
  out of Prometheus.
- The dashboard queried `service_name`; Tempo's span metrics label is `service`. Same cause, same discovery.
- The Grafana Postgres datasource used `${VAR:-default}`. Grafana's provisioning interpolation expands
  environment variables but does not understand bash-style defaults, so it authenticated with a literal and
  failed. Plain `$VAR`, with the default in the compose file.

### Added (task 2.6 — secret injection and the runbook index, issue #36)

- `infra/terraform/modules/external-secrets` — the IRSA role External Secrets Operator assumes. Read-only, and
  scoped to one environment's `<env>/platform/*` and `<env>/stores/*`: it cannot read another environment's
  secrets and cannot write, because an operator that can write can silently replace a credential nobody chose.
  The operator itself stays a Helm release in the bootstrap runbook — a cluster add-on with CRDs, and
  Terraform holding Kubernetes objects would make every `plan` need cluster credentials.
- `infra/kubernetes/external-secrets/cluster-secret-store.yaml` — cluster-scoped, so a bootstrap step rather
  than something an ArgoCD sync may create.
- The secret naming scheme, documented in `infra/README.md`: `<env>` first so the IAM policy is a prefix and
  not a pattern, per-store paths for anything a store owns, and the store _code_ rather than its UUID so a
  human granting access can read the path. ADR requested in #155 (`docs/adr/**` is main's).
- CI job `secrets`: the `gitleaks` **CLI in a container**, over the repository **and its history**, unconditionally — a path filter on a
  secret scan only guarantees that the PR adding a key to an unwatched directory is the one not scanned.
  `infra/gitleaks.toml` extends the default ruleset and only adds allowlists, each with a stated reason.
- Runbook index at the top of `infra/README.md` covering the six flows, with **rotating a secret** and
  **rolling back a deploy** written out: rotation is two steps and the second (making running pods notice) is
  the one people forget, and a rollback is a git revert precisely so that the next ArgoCD sync does not undo
  it.

### Changed

- `infra/ci/run-e2e.sh` no longer greps each app's Playwright config for `channel: 'chrome'` (#99). It exports
  `E2E_CHANNEL` and installs what it asked for. On CI it installs both browsers for now, because
  `apps/admin/playwright.config.ts` still pins the channel and ignores the variable (REQUEST #154) — removing
  the grep without that would have broken the admin journey the first time it ran in CI.
- Two README nits: the orphaned `helm/ … argocd/` bullet stranded after the Observability section, and the
  OTel snippet's `store_id`, which was a slug where `app.outbox_lag()` returns a uuid.

### Fixed (close-out of the #156 review)

- `infra/ci/run-e2e.sh` decides the browser channel **once, before the loop**. It used to decide per app, and
  the `unset E2E_CHANNEL` for one app changed what the next one saw: with an explicit `E2E_CHANNEL=''` and no
  `CI`, the first app got bundled chromium and the second silently fell back to Chrome. Verified both before
  and after — every app now gets the same answer.
- The External Secrets IAM role no longer grants `secretsmanager:ListSecrets` on `*`. The comment claimed
  `ListSecretVersionIds`, but neither is needed: every ExternalSecret in the charts uses `dataFrom.extract`
  with a named key, and `ListSecrets` is only required for `dataFrom.find`. An account-wide grant has no place
  on a role whose entire purpose is two prefixes — if a later window wants find-based discovery, that is a
  REQUEST and a deliberate decision.
- `zricethezav/gitleaks` pinned to `v8.30.1`. On `latest`, a new upstream rule turns a green `main` red
  overnight with no change of ours.
- `.github/workflows/ci.yml` declares `permissions: contents: read` at the workflow level. Nothing in it
  writes; `deploy-staging.yml` raises its own.

### Added (#195, #197 and the manager's batch)

- Images for `apps/feeds` (port 4020) and `apps/storefronts/brand-a` (port 3101), and the two new workspace
  manifests added to the `deps` stage of all eight app Dockerfiles — which turns the `app images` job on `main`
  green again. The guard named exactly what was missing, which is what it is for.
- **A real boot of `apps/core` in the `auth-e2e` job** (`infra/ci/boot-smoke.sh`): build, start against the
  compose stack, wait for `GET /health` 200, stop. Every other check reasons about the code without running
  the server, so a Medusa loader failure was a production outage CI reported as green.
- `paths-ignore` for `docs/**` and `**/*.md` on the **push** trigger, so a memory-only commit to `main` starts
  no run. Not on `pull_request` — see the note in `infra/README.md`: with five required checks, a workflow that
  does not run reports nothing and the PR can never merge.

### Changed

- Brand storefront journeys (`apps/storefronts/*`) are **opt-in** in `infra/ci/run-e2e.sh`:
  `E2E_INCLUDE_BRAND_STOREFRONTS=1`, default off. `apps/*` discovery is unchanged. Brand-a inherits the
  starter's account journey, which signs in through Keycloak, but the realm's brand client only registers the
  starter's port (3100) as a redirect URI and brand-a serves on 3101 — so it fails for a reason unrelated to the
  brand (REQUEST #212, window 2). The job log lists the brand journeys it did not run and how to run them, so
  the gap stays visible. Flip the default when #212 lands.

### Fixed

- **The boot smoke ran core against an empty database**, so it would have stayed red even after REQUEST #207.
  It now creates `platform_boot_smoke`, migrates and seeds it (`pnpm db:migrate && pnpm db:seed`), runs
  Medusa's migrations, then boots — and drops the database afterwards. Its own database rather than the shared
  `platform` one: re-seeding that under other windows, or leaving it half-migrated on a failure, is not
  acceptable. Verified: on a fresh database core reports `bootstrap check: ready (3 store(s))`, and with #207
  simulated the whole step exits 0 with `/health` answering in 21s.
- **The `feeds` image exited on start.** It sets `NODE_ENV=production`, and the feed server refuses to start in
  production without `FEEDS_STORE_CODES`. Documented as a runtime requirement in the image contract and the
  Dockerfile, with a `brand-a` placeholder in the build compose. Deliberately not defaulted in the Dockerfile:
  a baked-in store code would defeat the guard. Verified: without it the container exits, with it the
  container is healthy and `/health` answers `{"status":"ok"}`.
- Three discovery globs assumed `apps/*` and silently skipped `apps/storefronts/<brand>/`:
  `check-image-manifests.sh` stopped checking a whole class of image, `smoke-images.sh` never tested one, and
  **`run-e2e.sh` never ran brand-a's Playwright journey** although the app has both a config and an `e2e`
  script. A discovery bug in a test runner does not announce itself; it just reports fewer passes than there
  are tests.
- Branch-protection documentation says "applied", and lists the five checks GitHub actually enforces rather
  than all nine jobs.

### Notes

- `scripts/check-ownership.sh` is unchanged and remains the first CI job (owned by the main window).
- Nothing has been applied to a real AWS account. Task 2.2 stops at `terraform validate`, as agreed, until the
  owner provides credentials; `plan`/`apply` are runbook steps.
