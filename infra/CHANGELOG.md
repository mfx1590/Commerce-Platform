# infra — changelog

Window 5 (Infra & DevOps). Owned paths: `infra/**`, `.github/workflows/**`, `**/Dockerfile`.

## Unreleased — Phase 6

### Added (#785: admin-metrics latency in the scheduled k6 SLO regression)

- `k6/metrics.js`: 2 req/s against `GET /admin/metrics` and `POST /admin/metrics/query`, as the staff realm's dev
  `analyst`. A real JWT plus the core's OpenFGA check, so the production auth path; re-granted before expiry. The
  gates are p95 < 300 ms on both tags (`slo-thresholds.js`: `adminMetricsP95Ms`, with the self-test against
  admin-metrics-latency); **small data: a lower bound**. The zero-requests rule covers both tags.
- `infra/load/ch-seed.mjs`: the generated month into ClickHouse `raw_events` through the ingest's public classify and
  sink. Its event count per store sits next to the gate in the summary.
- `load.yml` adds the compose ClickHouse, `ch:migrate`, the seed (`metrics_months`, default 1), `fga:seed`, and the
  dev password, read from the realm file and masked. The ClickHouse passwords come from `openssl rand`, masked.
- `.github/dependabot.yml`: `sanity` and `@sanity/vision` majors join the "UNTIL THE NODE 22 MOVE" block (Sanity 6 needs
  Node >= 22.12; #796, #799).

### Changed (#758: the starter's packages are back in Dependabot)

- `.github/dependabot.yml`: the 19 starter-package ignores are removed. Since #789 the brands' sync-merge tests accept
  a plain-semver version bump on a key the brand shares with the starter (and still catch a protocol swap), so a
  grouped bump of the starter and the brands is no longer red by construction. The `@types/node` major rule and the
  whole "UNTIL THE NODE 22 MOVE" block stay.

### Added (the scheduled k6 SLO regression, plan wave 3)

- `.github/workflows/load.yml` runs weekly (Mondays 04:00 UTC) as well as by hand. The schedule runs the target only,
  gated on the SLOs, and retries once before a breach counts. It comments every run on the tracking issue, and a
  confirmed breach opens or updates "load regression (scheduled k6)" from a schedule-only job with `issues: write`. A
  manual run prints both texts as a dry run, and the `threshold_factor` input forces a breach to prove that path.
- `infra/load/k6/slo-thresholds.js`: the gates in one place. `lib.js`, `load.js` and `report.mjs` read it, and
  checkout `complete` gets a real p95 < 2 s gate (it was 60 s), a lower bound with the manual payment provider.
  `slo-thresholds.test.mjs` asserts it equals `rules/slo.mjs`.
- `infra/load/slo-gate.mjs` (+ test): the verdict per pass, the retry-once rule, the tracking comment and the issue body.
- Admin-metrics latency is not covered yet: #785.
- A pass that cannot be judged fails the run as `broken`: "infrastructure, not a regression", with no regression issue
  (#788 review). That covers k6 crashing, or an SLO route with zero requests, since a threshold on an absent tag
  passes vacuously. `threshold_factor` must be a number > 0 (the workflow and slo-thresholds.js both refuse it). The
  issues job has a timeout, and the regression issue gets the `load-regression` label.

### Changed (service images hygiene; Dependabot's Node 22 checklist)

- `TZ=UTC` in every service image's runtime stage (only accounting had it; #627: node-postgres turns a `date` column
  into a local midnight). `check-image-manifests.sh` now fails an image without it.
- `check-image-lists.sh`'s header says why Helm values and deploy-staging's APPS are not compared (they list what is
  deployed, #342).
- `.github/dependabot.yml`: one "UNTIL THE NODE 22 MOVE" block, the move's checklist. `@types/node` majors, Medusa
  > = 2.22, the OTLP exporters >= 0.300 (the SDK 3 line, #775), `@axe-core/playwright` >= 4.14 (#778) and
  > `@testing-library/jest-dom` majors (#780). The TS2345 in `db-medusa-migrate.ts` is now attributed to Medusa 2.21,
  > which stays allowed.

### Added (#439: every image in every list; the engagement image; per-brand Helm values)

- `apps/engagement/Dockerfile` (a worker: `node dist/main.js`; no HEALTHCHECK, because its one HTTP server, the
  support API, is opt-in on 4040), plus a compose build service and a bake target.
- terraform `var.apps` (ECR) gains `engagement`, `feeds` and `storefront-brand-{a,b,c}`, so it matches the images
  again. `smoke-images.sh` gains `storefront-brand-{b,c}` and `engagement`.
- `infra/ci/check-image-lists.sh` (in the `changes` job): the compose services, bake targets, terraform `var.apps` and
  the smoke list must name the same images. On main before this it reported terraform missing 4 and smoke missing 2.
- `infra/helm/values/storefront-brand-{a,b,c}/values-{dev,staging}.yaml`: each brand's port, host, image and its own
  staging key path. `check-values.sh`'s SITE_URL/robots rules now cover every `storefront*` directory (+1 fixture).
  NOT deployed: ArgoCD Applications and the deploy-staging list stay with #342.
- `docker-compose.build.yml`'s header no longer says bake must run from `infra/docker` (BAKE_CONTEXT, #767).

### Added (#745: the Redis halves of the rate limits run in CI)

- The `unit` job gets a `redis:7-alpine` service on host port 6381 (the compose port, so `packages/ai`'s limiter test
  finds it by default). A new step runs `apps/core/src/http/rate-limit.redis.test.ts` (with `CORE_TEST_REDIS_URL`)
  and `packages/ai/test/limiter.test.ts` directly, and `require-live-tests.mjs` fails it unless every test under the
  three pinned blocks PASSED:
  - `the Redis token bucket (#742)`;
  - `Redis limiter (local Redis, prefixed keys, self-cleaning)`;
  - `Redis key layout (#669)`.
- Proven both ways locally: 8/8 with Redis; with none, vitest exits 0 (all skipped) and the pin fails. Directly, not
  through `pnpm test`, because turbo's strict env mode would not pass `CORE_TEST_REDIS_URL`.

### Added (#647: the analytics ingest's Helm values, one replica with Recreate)

- `platform-app` chart: a `strategy` value, rendered into the Deployment only when set (default `{}`: Kubernetes'
  RollingUpdate, unchanged for every app).
- `infra/helm/values/analytics-ingest/values-{dev,staging}.yaml`: `replicaCount: 1`, `autoscaling.enabled: false`,
  `strategy.type: Recreate`, port 9004 with `/health` for all three probes, no ingress, ClickHouse and bus settings, the
  password and erasure key through ExternalSecrets. Not yet deployed: no ArgoCD Application, and deploy-staging does
  not build the image.
- `check-values.sh`: every analytics-ingest values file must keep those three lines (block style), with six
  self-test fixtures, including one where only the ingress block says `enabled: false`.

### Changed (actions: one PR for the majors and bake-action v7)

- `docker/bake-action` v7 with `source: .` (the checkout) in `ci.yml` and `deploy-staging.yml`; v6+ otherwise builds
  from the Git context (#743). v7 also has no `workdir`, so bake runs from the repo root: the files are named from there,
  and `docker-bake.hcl` takes every target's context from `BAKE_CONTEXT` (default `../..` for running from infra/docker,
  `.` in CI). Its Dependabot major ignore is gone.
- Dependabot's actions group #759 folded in (its commit cherry-picked): checkout 7, setup-node 7, pnpm/action-setup
  6, cache 6, upload-artifact 7, setup-buildx 4, setup-terraform 4, setup-helm 5, configure-aws-credentials 6.

### Changed (Dependabot regrouped after the red groups #743, #747, #755)

- `@medusajs/*` moves as its own `medusa` group (minor/patch), outside production/development; `@medusajs/*` >= 2.22
  is ignored (it needs Node 22: execa 10). The storefront starter manifest's 19 packages are ignored in every update
  type: Dependabot edits the brands' `package.json` but never their manifest, so brand-a's sync-merge test makes
  every such PR red. They move through the starter sync instead (#758), and the audit gate still covers them.
  `docker/bake-action` majors are ignored (v6+ builds from the Git context; `workdir` stops applying).

### Changed (relay SLO is live; Dependabot ignores)

- `infra/observability/SLO.md`: the relay-lag SLI reads the real gauge (#733, #751), in window 14's wording; the core's
  SLIs are marked live (#729). No "metric pending" is left in the rules.
- New alert `SLOAbsent_outbox_relay_lag` (page): `absent()` of the relay's gauge `for: 5m`. A down relay exports nothing,
  so no burn alert can fire. The promtool cases: the gauge stops after 10 minutes (silent at 12m, firing at 30m), and
  the alert is silent wherever the gauge is present.
- `.github/dependabot.yml`: majors are ignored for `@types/node` and the `node` image (they move with the runtime), and
  for `@medusajs/*`, `@opentelemetry/*`, `express` and `@types/express` (they move with Medusa).

### Added (#741, P6.3 — backup + restore drill; #735)

- `infra/dr/drill.mjs` + `docker-compose.drill.yml`: back up Postgres, ClickHouse, Keycloak and OpenFGA from the shared
  dev stack; restore into a fresh `commerce-dr` stack; check counts, per-store counts, checksums, per-topic events, a
  staff login and a permission check; RTO/RPO; teardown always. `infra/dr/RUNBOOK.md` has the numbers. Self-test
  in the `changes` job.
- Grafana: a "Core per route" row (#735): rate per route and store, the 5xx share per route (0, not "no data", before
  the first 5xx), p95 per route, responses by status class.

### Changed

- `infra/load/README.md` no longer says the core has no OpenTelemetry (#729).

### Added (#730, P6.2 — dependency scanning and SLOs as rules)

- CI job `dependency audit (production)` (advisory, every PR): `pnpm audit --prod` + `infra/ci/audit-gate.mjs`, failing
  on a high/critical production advisory outside `infra/security/audit-allowlist.json` or past its entry's expiry
  (self-test in the `changes` job). The allow-list starts with a dated baseline of the 28 high/critical advisories on
  main `33cb5b6f`.
- `infra/observability/SLO.md` and `rules/slo.mjs` → `rules/slo.rules.yml` + `rules/slo.test.yml`: eight SLOs with
  recording rules and multi-window burn-rate alerts, checked by `promtool check rules` and `promtool test rules` in the
  `observability config` job; Prometheus loads them (`rule_files`, compose mount).
- `.github/dependabot.yml`: weekly grouped minor/patch updates (npm production, npm development, GitHub Actions,
  Dockerfile base images); majors as single PRs.
- `#733`: REQUEST to window 14 for the relay lag gauge.

### Fixed (#730 review)

- The checkout-latency and ingest-lag SLIs selected `le="2"` / `le="10000"`, which Prometheus 3 stores as `"2.0"` /
  `"10000.0"`: the recordings would have been empty and the alerts silent. The rules now match both spellings
  (`le=~"2(\\.0)?"`), and the promtool series spell the stored form literally. The availability SLIs read a missing
  5xx series (none exists before the first 5xx) as 0 (`or vector(0)`) instead of recording nothing; the healthy
  promtool cases have no 5xx series at all. Two more gate self-tests: non-JSON audit output, and a multi-path advisory.

### Fixed

- `infra/README.md` → Branch protection lists the six checks GitHub enforces; `live auth + end-to-end` is not one
  (plan D6). Two `ci.yml` comments said otherwise.

## Unreleased — Phase 3

### Fixed (Refs #346 — the owner-logins witness warned on the wrong thing)

- `infra/ci/owner-grants.sh` warned when two SUCCESSFUL owner logins fell in one TOTP step. Keycloak refuses a reused
  code, so two successes in one step mean two different codes were accepted — the shared fixture working. It now
  warns on REFUSED owner logins (`LOGIN_ERROR`), which is what a collision looks like; "0 refused" is the evidence.
  Still report-only: it never fails the job.

### Removed (#346 — the TOTP barrier, now that the suites share one owner-token fixture)

- The 30–60 s `TOTP barrier` step and `infra/ci/totp-barrier.sh`: #387 (auth-sdk) and #401 (core) made each
  live suite sign `owner` in once through a shared fixture, so they no longer collide on a one-time code or depend
  on order. The barrier's witness half lives on as `infra/ci/owner-grants.sh` (report only, never fails the job):
  every owner login in the job by TOTP step, with a warning if two successful ones share a step.

### Fixed (#380 — the live job's kept core had no OpenFGA)

- `auth-e2e` now seeds OpenFGA (`fga:seed`) after the live suites and before the kept core boots, exporting
  `OPENFGA_STORE_ID` / `OPENFGA_MODEL_ID` to the job (masked in the log, asserted present, `.env` removed) — the
  same step `admin-e2e-core` has. Without it the core answered 503 `FgaValidationError` to the first real staff
  token, brand A's order-lifecycle spec (#379).

### Added (#359 — load test against the real core, Integration 2a)

- `infra/load/`: `k6/load.js` (browse 50 req/s + place 30 orders/min, 10 min, thresholds on the owner's target),
  `k6/pool.js` (`GET /store` ramp 50 → 800 req/s, the app-pool knee), `k6/ceiling.js` (placement-only ramp
  30 → 960 orders/min on one store), `pg-sampler.mjs` (pg_stat_activity
  once a second for the run's database), `report.mjs` (+ a 15-case self-test in the `changes` job) and `run.sh`
  (fresh kept core via boot-smoke keep mode, stock on that database only, the pinned `grafana/k6:2.3.0` image).
- `.github/workflows/load.yml` — **load (manual)**, `workflow_dispatch` only, uploads the summary and report.
- `infra/load/reports/2026-10-06.md` — the laptop run and the GitHub-runner run against the target.

### Added (Refs #348 — the perf gate shows what it measured, pass or fail)

- `infra/ci/lighthouse-summary.mjs`: after every perf leg, pass or fail, prints per URL every run's value for each
  numeric assertion in the storefront's `lighthouserc.json`, the CPU benchmark per run, and the value the
  assertion compared (LHCI's aggregation: `optimistic` = best run, `pessimistic` = worst, `median`), with the
  budget and the margin — to the log and the job summary. A witness: always exits 0. Self-test (5 cases, one of
  them #341's failing leg) in the `changes` job. No threshold changed.
- The Lighthouse reports are uploaded on success as well as failure (30-day retention).

## Unreleased — Phase 2

### Added (REQUEST #285 — admin e2e against the real core, advisory)

- CI job `admin-e2e-core`: the compose auth stack, `fga:seed` (ids exported to the job, `.env` removed), the core
  kept running through `boot-smoke.sh`'s keep mode with no dev tokens, then `E2E_API=core pnpm --filter
@platform/admin e2e` on :3200. Seeded realm test users only, no new secrets. Advisory (not in branch protection)
  until it has a week of green runs; the Prism variant in `auth-e2e` stays required.

### Fixed (owner-TOTP collision on `live auth + end-to-end`, follow-up to #344)

- #344 ran the core live suites before auth-sdk's on the claim that the core then spends only the previous TOTP
  step's code. Wrong: when that code is refused the core's helper spends the CURRENT one, which auth-sdk's suites
  need seconds later (PR 345, run 37293071865: hq-rbac `scope.test.ts`, "token for owner: invalid_grant",
  126/129). `infra/ci/totp-barrier.sh wait` now sleeps from the end of the core step (step S) until step S+2
  begins, so the core's codes (<= S) and auth-sdk's (>= S+1) cannot meet. `report` prints every owner grant by
  step from Keycloak's event log (CI-only overlay `infra/ci/compose.keycloak-events.yml`). No test edited.

### Added (REQUEST #297 — core live suites in CI, the deployed customers realm, staging key, production values)

- `auth-e2e` runs the core's live suites (`apps/core/test/auth-live.test.ts`, the live block of
  `customers-api.test.ts`), which ran in no CI job before; `infra/ci/require-live-tests.mjs` reads vitest's JSON
  report and fails the step unless every named live block ran and passed (a missed stack probe used to skip them
  silently). Self-test in the `changes` job.
- `infra/deploy/keycloak/derive-customers-realm.mjs`: the deployed customers realm, generated from window 2's
  export — no `test-cli`, no users, no localhost URIs, `verifyEmail: true`, `trustEmail: false`, no auto-link.
  Mutation-tested in the `helm` job; the classifier's `helm` group now also fires on `infra/deploy/` and the
  customers realm export.
- `infra/helm/check-values.sh` (split out of `check.sh`) + `check-values.test.sh`: production `SITE_URL` covered by
  a fixture case; `values-production.yaml` / `values-prd.yaml` refused; a seeded `_dev_` publishable key refused
  in staging/production values.
- Staging storefront (the starter) no longer carries brand A's dev key: `STORE_PUBLISHABLE_KEY` comes from
  `staging/stores/brand-a/storefront`.
- Deploying Keycloak to dev/staging moved to #342.

### Changed (REQUEST #295 + #297 item 1 — brand A's browse → buy in CI against the core)

- `infra/ci/boot-smoke.sh`: `CORE_SMOKE_KEEP=1` leaves the booted core running (own session via `setsid`, pid and
  database in `$CORE_SMOKE_STATE`, `CORE_STORE_API_FALLBACK_URL` defaulting to Prism); `--stop` kills its process
  group and drops its database, always exiting 0.
- `infra/ci/run-e2e.sh`: brand storefront journeys are on by default (`E2E_INCLUDE_BRAND_STOREFRONTS=0` opts out);
  the #212 paragraph is gone. Brands get `E2E_STORE_API_URL` = the kept core; on CI an unreachable core fails the
  brand journey instead of falling back to Prism.
- CI `auth-e2e`: the boot step keeps the core up, a stop step drops it before the stack stops, and the Playwright
  report upload covers `apps/storefronts/*/playwright-report`.
- From the #336 review: `changes.sh` emits `perf_unmeasured` (changed brand storefronts with no `perf` script) and
  the required perf check fails on it, instead of the same green "no storefront changed". Self-test cases added.

### Changed (REQUEST #283 — the perf gate measures every storefront that changed)

- `infra/ci/changes.sh` emits `perf_apps`, a JSON array of the storefronts to measure (each
  `apps/storefront-starter` / `apps/storefronts/*` with a `perf` script). `apps/storefronts/**` now fires `perf`;
  before, only the starter's path did, and brand A's theme change on #280 passed the gate without running it.
  Self-test cases for brand-only, starter-only, both, shared-package, root-file and prefix (`brand-ab`) changes,
  plus one against the real directory scan.
- CI: the perf job is a matrix (`perf-app`) over `perf_apps`, each storefront with its own package, budgets and
  `lighthouserc.json`, and its own `lighthouse-reports-<storefront>` artifact. The required check keeps its name
  as an aggregator (`perf`) that fails unless the classifier succeeded and every entry passed.
- Corrected "median of three": LHCI asserts on the best of three runs by default (`optimistic`), the worst for
  `pessimistic` assertions. Noted that the starter's home page has no Lighthouse or axe check in CI.

### Added (REQUEST #257 — storefront SITE_URL, robots indexing guard, performance CI job)

- **`SITE_URL` in the storefront's dev and staging values** (`https://shop.<env>.example.com`). Without it a
  pod built its OIDC redirect URI from the `http://localhost:3100` fallback, so customer sign-in broke on
  every deployed environment with no error anywhere; it also drives canonicals, `hreflang`, the sitemap and
  the `robots.txt` host.
- **`infra/helm/check.sh` asserts the storefront's silent-failure values**: `SITE_URL` must equal
  `https://<ingress.host>`, and `ROBOTS_ALLOW_INDEXING` must be `'1'` in a `values-prod.yaml` and absent
  everywhere else (`robots.ts` serves `Disallow: /` when it is unset). There is no production values file
  yet; the day one is added, the check refuses it without the flag. Verified in both directions.
- **CI job `perf`** — window 3's `pnpm --filter @platform/storefront-starter perf` (bundle budget + Lighthouse
  CI) against Prism, as a gate: exit 1 fails the job. New `perf` group in `infra/ci/changes.sh` (storefront,
  `packages/ui`, `packages/contracts`, `cms/`, workspace root files) with self-test cases.
- No Dockerfile change: the `KEYCLOAK_URL` build-argument ask was withdrawn in #257 — the storefront's CSP
  is built per request in its middleware from the pod's environment.

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

- OpenFGA playground host port **3001 → 18083** (`infra/docker/docker-compose.yml`, the README ports table,
  `infra/openfga/README.md`). On a Windows machine whose dynamic port range starts at 1024, WinNAT reserves
  random 100-port blocks below 15000 and moves them on every restart; 3001 landed in 2917–3016 and compose
  refused to start OpenFGA at all, taking the API down with the playground. The originally agreed 3081 was
  already inside another block (3055–3154), so the port went above 15000 instead. Verified: the container
  starts, the API and the playground both answer 200. The README now lists which stack ports sit below 15000
  and the two owner-side remedies.
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
