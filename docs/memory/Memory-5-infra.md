# Memory 5 — Infra & DevOps

Window: 5 · Key: `infra` · Branch prefix: `infra/` · Model: Opus
Last updated: 2026-10-07 · Contracts: `contracts-v0.1` · Branch: `infra/phase3` · Worktree: `../wt-infra`
Status: **quiet** (2026-10-07). #380 done: PR #381 merged as `7a4abb4`. Before: #359 (PR #364 = `ec6b158`). Reopened only by the manager ("Project manager handoff").
Previous status: **Phase 2 complete** — 2.1 through 2.6 merged (2.6 = PR #156, main `6931293`). Close-out PR open; then
this window is quiet until the manager reopens it with REQUEST issues.

## Identity (does not change)

Owned paths (write):

- `infra/**`
- `.github/workflows/**`
- `**/Dockerfile`
- plus `docs/memory/Memory-5-infra.md`, `.claude/CLAUDE.local.md`, `pnpm-lock.yaml`

Reads:

- all apps' run commands

Never touches:

- application source, `scripts/check-ownership.sh`, `docs/**` other than this file, root config

## Mission — Phase 2 (Commerce complete, brand 1 live)

Terraform for dev + staging, Kubernetes, Helm/ArgoCD for core/admin/mock API, GitHub Actions pipelines
(lint/typecheck/test/contract/ownership-check, preview per PR, deploy staging on merge), OTel →
Grafana/Prometheus/Loki/Tempo, Sentry, Vault. Reproducible from an empty account.

## Done

- **2.1 — Dockerfiles for every app + build compose + CI image job (issue #31)** — commit `69d0480`, PR #45
  **merged** into main 2026-09-05 (merge commit `7df4aa9`).
  Six `apps/<app>/Dockerfile`, `infra/docker/{entrypoint.sh,health-server.mjs,docker-compose.build.yml,smoke-images.sh}`,
  CI job `images`, `infra/README.md` + `infra/CHANGELOG.md`.
  Verified locally: all six images build; smoke test green (uid 1000, HEALTHCHECK `healthy`, `/health` → 200);
  scaffold image ~221 MB (node:20-alpine + 24 MB pnpm; the app layers are ~100 KB).

- **2.1b — app images fixed for the real apps (issue #59)** — commit `e1bdfb3`, PR #69
  (https://github.com/mfx1590/Commerce-Platform/pull/69), all six checks green on a clean runner. Three defects, all found by building and
  running rather than reading: `pnpm --filter <app> build` never built the workspace dependencies;
  `medusa build` needs `ts-node` and a non-empty environment; and `pnpm deploy` silently dropped `.medusa` and
  `.next` because npm packing skips dot-directories. `continue-on-error` removed from the `images` job.
  Verified: all six images build, smoke test green, core and admin both boot inside their containers and fail
  only on missing configuration (a database / `ADMIN_SESSION_SECRET`), which is correct.

- **2.2 — Terraform for dev + staging (issue #32)** — commits `9b96f58` + `fd95530`, PR #74
  (https://github.com/mfx1590/Commerce-Platform/pull/74), all seven checks green (new `terraform` job 29s,
  `images` 13m02s). Seven modules + `envs/dev` + `envs/staging` + `infra/kubernetes/bootstrap-db` + CI job
  `terraform` + the runbook in `infra/README.md`, plus the repo-root `.dockerignore` (REQUEST #70) and the four
  doc fixes from the #69 review.
  Verified: `bash infra/terraform/check.sh` green (`fmt -check`, `init -backend=false`, `validate`, both envs).
  Nothing applied to a real AWS account — no credentials exist yet.

- **2.4a — CI caching, path filters, and two review fold-ins (issue #34, first half)** — commits `e7fe27e`,
  `3c1e50d`, `aa86f8c`, `2660173`, PR #81 **merged** (https://github.com/mfx1590/Commerce-Platform/pull/81), all eight checks green.
  Measured on the PR — node jobs warm: `lint + typecheck` 1m47s → 49s, `unit` 2m28s → 58s, `contract` 50s → 40s.
  `images`: 13m02s before → 14m20s (first attempt, cache never hit and export cost more than it saved) →
  **9m38s** after the remote-cache fix. All three of those are COLD runs. **The ~4 min warm target is not
  demonstrated yet and cannot be from a PR branch**: pull requests read the cache and only pushes to main write
  it, so the first warm number appears on the first PR opened after this merges. Check it then; if it is still
  far off, the next lever is the six identical `pnpm install`s — one shared base image would collapse them, but
  that needs a registry to push to (ECR exists in 2.2; wiring it is 2.3/2.4b).
  `infra/ci/changes.sh` + self-test replacing the two inline `git diff` filters; `infra/docker/docker-bake.hcl`
  (GHA build cache, one scope per image) driven by `docker/bake-action`; turbo task cache in the three node
  jobs; every Dockerfile split into a `deps` stage (the manifests and the lockfile, nothing else) and a
  `build` stage (the sources), so `pnpm install` no longer depends on source files. Plus `backend.hcl` ignored by name, and the bootstrap Job's credentials moved out of argv into
  the environment (`\getenv`).
  Verified locally: touching an app source file leaves `pnpm install --frozen-lockfile` `CACHED`; all six
  images rebuild and the smoke test passes; `changes.test.sh` 18/18; the bootstrap SQL was run twice against a
  real Postgres (create, then rotate) with a password containing a quote, and the test roles dropped after.

- **#80 — one CI job for the live auth suites and the Playwright journeys** — commits `19675b1`, `a96b9ec`,
  `5e995f3` (+ the review fixes below), PR #87
  (https://github.com/mfx1590/Commerce-Platform/pull/87). `auth-e2e` boots
  Keycloak (both realms), OpenFGA and Postgres from the compose file, asserts they are really up, runs
  `turbo run test --filter=@platform/auth-sdk` (which covers apps/core hq-rbac too) and every
  `apps/*/playwright.config.*`. Also adds the `e2e` group and `infra/ci/**` to the classifier.
  Verified locally: 51/51 live auth tests against a freshly imported realm, and the storefront journey
  6/6 through `infra/ci/run-e2e.sh`.

- **2.3 — Helm charts + ArgoCD (issue #33)** — this PR. One `platform-app` chart + 10 values files + 10 ArgoCD
  Applications + `infra/helm/check.sh` + CI job `helm` + the bootstrap runbook.
  Verified locally: `helm lint`, `helm template` for all ten app/environment combinations, `kubeconform -strict`
  with the CRD catalogue over everything rendered and over `infra/argocd`.

- **2.3 — Helm charts + ArgoCD (issue #33)** — merged as PR #95 (commits `8b7b78b`, `c92e757`). The review
  caught three real defects, all of which would have rendered, validated and then not worked: mock probes that
  answer 401 (Kubernetes counts only 200-399 as success), no `env:` anywhere so apps would fall back to
  localhost, and `stoplight/prism:5` as a moving tag.
- **2.4b — deploy-staging + branch protection, and the two #95 follow-ups** — this PR.
  `deploy-staging.yml` (no-op until five settings exist), the nine required checks documented, migrations as an
  ArgoCD PreSync hook running the app's own image, and the rotation path fixed with Reloader.

- **2.5 — observability (issue #35)** — PR #151, main `8941f1e`. `--profile observability` adds the OTel
  collector, Prometheus, Loki, Tempo and Grafana on 4317/4318, 9090, 3410, 3420, 3400; provisioned
  datasources and a four-panel dashboard; `infra/observability/check.sh` + CI job; the OTel snippet, Sentry
  wiring and the trace runbook.
  Verified by running it: all five up, four datasources healthy, a span posted to the collector read back out
  of Tempo, span metrics reaching Prometheus with a `store_id` label, and the panel expressions returning
  real values (0.025 req/s, p95 15.6 ms for brand-a).
- **2.6 — secret injection + runbook index (issue #36), and #99** — PR #156, main `6931293`. External
  Secrets IRSA module,
  ClusterSecretStore, the `<env>/platform` + `<env>/stores/<store_code>` naming scheme, gitleaks over history,
  the six-flow runbook index, and run-e2e.sh no longer grepping app configs for a browser channel.

## In progress

- **#380 — DONE: PR #381 merged as `7a4abb4`** (head `acd73aa`; live job green twice: jobs 112664751867 and
  112667098011, seed step "exported … (26 chars)"; the brand-a perf leg was red once on PDP LCP 2554 vs 2500 (#348),
  and the manager's re-run passed). Original note: `auth-e2e` never seeded OpenFGA, so the kept core answered 503 FgaValidationError to the first real
  staff token (brand A's order-lifecycle spec, #379). Fix: a seed-and-export step (same as admin-e2e-core) after the
  live suites and the TOTP report, before "core boots for real"; ids masked (`::add-mask::`), asserted, `.env`
  removed. Branch `infra/phase3` from main `5b119ff` (the old local branch is kept as `infra/phase3-old`).
  Evidence: two consecutive green runs of the live job on the final head, URLs in the PR body. "Closes #380".

- **#359 — k6 load test against the real core (Integration 2a). DONE: PR #364 merged as `ec6b158`** (final head
  `0ba6a5b`, all 16 checks green). Report `infra/load/reports/2026-10-06.md`: target passes on laptop ×2 + runner;
  pool knee 200–400 req/s of GET /store (ceiling ~380–390 req/s, DB_POOL_MAX=10); store lock ≥ 960/min. Laptop
  ramps on AC never re-run (laptop stayed on battery) — offer stands: `LOAD_SKIP_TARGET=1 bash infra/load/run.sh`.
  History below. Branch `infra/phase3` from main `c0e5202`.
  The laptop is MINE until I report "machine free" (manager, 2026-10-06). Target: 30 orders/min for 10 min while
  browsing at 50 rps; p95 < 500 ms for GET /store, product list, product detail; errors < 0.1%.
  Facts found: k6 is not installed locally → run the pinned `grafana/k6` image (same binary on the laptop and in
  CI). Core app pool `DB_POOL_MAX` default 10 (apps/core/src/lib/db.ts) with 4 connections per GET /store.
  completeCart locks the cart FOR UPDATE, then reservations under level-row locks; the store-row lock is to be
  located and measured. Payment session `provider: manual`; complete needs `Idempotency-Key` (minLength 8).
  **PLAN (awaiting OK):**
  1. `infra/load/k6/load.js`: one k6 run, two scenarios at once, using constant-arrival-rate.
     - browse: 50 rps for 10 min, mix store 20% / list 40% / detail 30% / search 10%, tagged by route.
     - place: 0.5 iterations per second (30/min) for 10 min, running cart → line item → email + addresses →
       shipping options → shipping option → manual payment session → complete with Idempotency-Key.
       Each step is tagged; a variant is picked by stock at setup.
     - Thresholds: p95 < 500 per browse route, errors < 0.1%, plus counts of placed orders.
  2. `infra/load/k6/ceiling.js`: a stepped placement-only ramp (30 → 60 → 120 → 240 /min, 1 min each) on one
     store, to find where the store-row lock serialises placement. Reports the knee.
  3. `infra/load/run.sh`, on the laptop and in CI:
     - start a kept core with `CORE_SMOKE_KEEP=1 boot-smoke.sh` (fresh `platform_boot_smoke` DB), then
       `top-up-stock` on that DB;
     - run a Postgres sampler at 1 s via `pg_stat_activity` for that DB (by state, waiting, wait_event_type=Lock)
       plus pool settings;
     - run `docker run grafana/k6` (laptop: host.docker.internal:9000; CI: --network host), with summary JSON
       and raw CSV;
     - stop the core with `--stop`.
  4. `infra/load/report.mjs`: summary + sampler → Markdown, pass/fail per target line, p50/p95/p99 per route,
     orders/min achieved, error rate, peak connections vs pool max and time at saturation, lock waits, the
     placement knee, and what Grafana would need (an OTel exporter in the core, pg-pool metrics, k6 → Prometheus
     remote write). Self-test with a fixture summary.
  5. `.github/workflows/load.yml` "load (manual)": workflow_dispatch only, uploads the summary and report.
  6. A laptop run commits `infra/load/reports/2026-10-06.md`. One PR, "Closes #359".
  Estimate: about 40–60 tool calls, plus 10-min runs ×2–3.
  **APPROVED 2026-10-06** (separate load.yml; fresh kept core on its own DB; `docker run` of the pinned k6
  image is an explicit exception; do NOT change DB_POOL_MAX or apps/core; the report states the laptop's specs;
  the CI run on a GitHub runner is the second datapoint before merge). **Manager is now the session
  "Project manager handoff"** (not "…takeover"): message it when the draft is up, when checks finish, and
  "machine free". Long runs detached, output to a file, bounded polls.
  Built (uncommitted): infra/load/{k6/lib.js,k6/load.js,k6/ceiling.js,pg-sampler.mjs,run.sh,report.mjs,
  report.test.mjs (10 ok),README.md,.gitignore}, .github/workflows/load.yml, a ci.yml step for the report test.
  Two smoke runs: fixed a Git Bash /tmp path mismatch (node reads /tmp as C:	mp → use `pwd -W`) and a hang
  (kill -INT never reaches native node → the sampler now stops on a `.stop` file). The laptop shows ~7–8
  `dial: i/o timeout` per run from k6's container to host.docker.internal; the report counts these apart from
  what the core answered. Full laptop run started 10:53 UTC.
  **Laptop results (2026-10-06):** run A 10:53 (clean) and run B 12:08 (target valid) both pass every target
  line (GET /store p95 25/23 ms, list 76/69, detail 37/35, errors 0.003%/0.000%, 300 orders, 50 req/s).
  Bottlenecks: the pool never saturated at target (busy max 8/6); the pool ramp held 100 req/s of GET /store
  (p95 20 ms), and the knee above that is NOT measured on the laptop. The placement ceiling held 240/min on one
  store (≥ 8× target) with no lock waits; serial floor ~840–913/min.
  **Laptop sleeps on battery**: Modern Standby voided run 11:16 entirely and run B's ramps after 12:22. The app's
  keep-awake doesn't hold on battery; the owner must plug in AC. Never change power settings. report.mjs now
  detects suspends (sampler gaps > 5 s) and voids those steps. Also fixed: a Math.min(...rows) stack overflow
  on big CSVs, and ceiling steps now anchored on the first cart_create (setup had shifted them).
  Report: infra/load/reports/2026-10-06.md (runner column pending). Next: commit, push the draft, dispatch
  load.yml on the draft, add the runner datapoint, message "Project manager handoff".
  **Draft PR #364** (head d85213e had a TEMPORARY `push: branches: [infra/phase3]` trigger in load.yml, the
  manager's option (a); remove it before ready and quote the run URLs in the body). ci.yml was all green on
  d85213e. Runner run 1 (37476880630): every phase ran (target 32,614 requests, 0%, 301 orders; pool
  77,243 requests), but k6 could not write /out (grafana/k6's non-root uid on a Linux bind mount) → summaries
  lost. Fix: `--user $(id -u):$(id -g)` on Linux. Also added LOAD_SKIP_TARGET (ramps-only) and a ramps-only
  render mode (15 tests). Laptop ramps are held until Windows shows AC (PowerLineStatus=Online); at 14:13 it
  was still Offline although the owner was said to have plugged in.
  **Runner run 2 (37479512779, head 9335cfe) clean:** target passes (GET /store p95 7 ms, list 41, detail 10,
  0 of 32,108 errors, 301 orders, 50 req/s). Pool knee between 200 and 400 req/s of GET /store alone; the
  throughput ceiling is ~380–390 req/s with all 10 connections busy. Store lock: 960/min held on one store, no
  lock waits (≥ 32× target). The report has all three datapoints. Temporary trigger removed in its own commit;
  main merged in the final push (35457f6+ carries the gitleaks allowlist for window 3's memory literals).

## Next

- After the perf-metrics PR: **quiet** until Phase 3 tasks are issued.
- **#342** (deploy Keycloak to dev/staging from the derived realm; brand A's Helm values / ArgoCD app / ECR repo)
  is BLOCKED on the owner's AWS account and domain. Do not start it. Recorded follow-ups there: one environment
  per derived-realm output; positive gate rules (https-only, no wildcard redirect, PKCE, sslRequired); SMTP +
  password policy; window 2's live first-broker-login check; the dev export's `trustEmail: true`.
- #348 (brand A listing-page LCP on its budget) is window 10's; this window supplies the measurement.

## Done (earlier)

- **#285** — PR #341 **merged** as `7568f56` (2026-10-05). Advisory job `admin e2e against the core (advisory)`;
  3× green at 22 passed / 1 skipped / 0 failed (run 37301539904; jobs 111735244122, 111738060290, 111739669910)
  after window 4's #345. Earlier: run 1 red in setup (fga:seed needs contracts dist → `d758bce`), run 2 20/3/0
  (spec vs fresh core → window 4). Required perf leg (brand A) red once on that head: PLP LCP best-of-three 2570.6
  vs 2500; re-run of that leg alone passed → #348 + the perf-metrics PR. Advisory until a week of green runs.
- **Phase 2 infra docket closed (2026-10-05):** #283, #295, #297, #285 and the TOTP barrier all merged.
- **Owner-TOTP collision on the required live job** — PR #347 **merged** as `7993482` (2026-10-05). #344's
  reorder was wrong (order is not a separation: PR 345 run 37293071865, hq-rbac scope.test.ts invalid_grant,
  126/129). `infra/ci/totp-barrier.sh wait` sleeps from the core step's end (step S) to the start of S+2;
  `report` prints owner grants by step from Keycloak's event log (CI overlay `infra/ci/compose.keycloak-events.yml`).
  5 consecutive green runs on `c190e28` (run 37294007283): core grants <= S, auth-sdk's in S+2 every time;
  core 40/40, auth-sdk 129/129. Held on #343 and #345 too. Caveat: no core LOGIN_ERROR in those runs.
  The real cure (second OTP user / shared owner-token fixture) is filed by the manager for windows 1/2.
- **#297 (rest)** — PR #344 **merged** as `1e14f03` (2026-10-05), built on main as a one-time second branch
  (`infra/phase2-realm`). Green head **`ecca795`** (run 37289318570): core live suites **40/40** (guard 10/10 and
  3/3), derived realm 16/16 (12 mutations), check-values 13 cases, guard self-test 6/6. Run 1 (`de59809`) was red:
  `node --test <dir>` on the runner's Node, and an owner-TOTP collision (auth-sdk spends current+next codes) →
  core live step moved BEFORE auth-sdk's. Review nits fixed in the next #341 push: values comments name
  check-values.sh; the `_dev_` key rule covers every non-dev values file, case-insensitive (+3 self-test cases).
- **#295 + #297 item 1** — PR #339 **merged** as `423f64b`: brand A journeys in CI against a kept core,
  four green live runs (91/0/22 each), `perf_unmeasured`. #295 closed; #297 open for the rest.
- **#283** — PR #336 **merged** as `978ebf4` (2026-10-05): perf gate per storefront (`perf_apps` matrix +
  `perf` aggregator keeping the required name). Brand A measured in CI for the first time (139.6/144 kB).
- **REQUEST #257** (window 3) — PR #272 **merged**, main `aa3b977` (commits `69fad5e` + `3432040`).
  `SITE_URL` in storefront dev/staging values; `infra/helm/check.sh` guard (`SITE_URL == https://<ingress.host>`,
  `ROBOTS_ALLOW_INDEXING` '1' in values-prod.yaml only — no prod values file created, no prod env exists);
  CI job `perf` on a new `perf` classifier group, with `ROBOTS_ALLOW_INDEXING: '1'` on the step (robots.ts
  fails closed → is-crawlable failed, SEO 0.69) and `include-hidden-files: true` on the report upload.
  The manager made `perf` a **required** check (six enforced). My flaky `meta-description` find (fails on
  Lighthouse runs 2-3 of each URL, server HTML fine) is #274, window 3's.
- The close-out PR for #156's review nits.
- feeds + brand-a images (#195/#197), `apps/core` boot smoke, `paths-ignore` on push, branch-protection docs —
  PR #210, merged (main `435b616`).

## Next — reopened by REQUEST, not by a phase

Phase 2 is complete. The manager reopens this window with issues; three are already signalled:

- a CI variant running the storefront journey against a real `apps/core` instead of the Prism mock, once
  core 2.2 lands;
- images for `apps/feeds` and the brand-a storefront (`infra/ci/check-image-manifests.sh` will fail the build
  until the new workspace packages are listed in every Dockerfile — that failure is the intended prompt);
- a Lighthouse job for window 3.

Later touch (nits from the #272 review, next time an infra PR is open anyway):

- `infra/helm/check.sh` treats a `values-production.yaml` as non-prod (only `values-prod.yaml` is prod). Safe
  (fails closed), but say so in the guard's comment.
- GitHub Actions Node 20 deprecation warning — bump the actions pinned in `ci.yml`/`deploy-staging.yml`.

Standing debts (parked), whenever this window is next open:

- **REQUEST #207** (window 1) — `apps/core` cannot start on main; the new boot smoke step is red until it
  lands. Verified fix: declare `@medusajs/draft-order` as a dependency.
- **REQUEST #212** (window 2's PR, also carries #257's shop.<env> callback URIs) — once merged, set `E2E_INCLUDE_BRAND_STOREFRONTS` on by default.
- **REQUEST #154** — once the Playwright configs honour `E2E_CHANNEL`, `run-e2e.sh` stops installing both
  browsers on CI and installs `"$channel"` alone. Supersedes #84.
- **REQUEST #60** — once `apps/core` declares `ts-node`, delete the two workaround lines from its Dockerfile.

## Decisions made (with reasons)

- **Dockerfiles live at `apps/<app>/Dockerfile`, build context = repo root.** `**/Dockerfile` is an owned path,
  so this needs no app-source edits, and a workspace build needs the root lockfile + `packages/**`.
- **No `.dockerignore`.** It would have to sit at the context root (main-owned) or next to the Dockerfile as
  `Dockerfile.dockerignore` (not matched by `**/Dockerfile`). Not needed: BuildKit's file sync only transfers
  what a `COPY` references, root `node_modules` (204 MB) is never copied, and the build stage deletes any
  workspace `node_modules` that came in with `apps/`+`packages/` (44–68 KB of symlinks each).
- **Runtime pnpm is installed with `npm install -g pnpm@<version>`, not corepack.** See Gotchas — corepack in
  the runtime stage is a live bug, not a style preference.
- **The scaffold health server lives in `infra/`, not in app source.** Issue #31 asked for "a 5-line health
  server" in the scaffolds, but `apps/*/src` belongs to windows 1/3/4. Putting it in the image entrypoint gives
  the same real HEALTHCHECK, needs no `CONTRACT CHANGE:` issue, and disappears by itself the moment an app
  defines a `start` script.
- **One container port per app (9000–9005)** so a future run-compose and the k8s services have a stable
  default. The build compose publishes nothing; only `smoke-images.sh` maps them to the host.
- **Inline path filter in the `images` job** rather than a third-party action — task 2.4 owns generalising it.

- **The image smoke test does not boot real apps, on purpose.** `apps/core` throws without `DATABASE_URL_APP`
  and `apps/admin` without `ADMIN_SESSION_SECRET` — correct fail-fast behaviour, not a bug to work around. An
  image test that spun up Postgres and Redis, ran two sets of migrations and invented secrets would be testing
  the deployment, slowly and flakily. So images are checked for what an image owns (non-root, build output
  present, right entrypoint) and the staging deploy owns "a configured app serves /health".
- **Workarounds for app defects live in the Dockerfile, each marked with the REQUEST issue that removes it.**
  Waiting for another window would leave main's CI red; editing their app would break ownership. Every
  workaround is one line with a comment naming the issue, so the cleanup is mechanical.
- **The admin and storefront images follow the app's hard-coded port (3000/3100) instead of the 900x
  allocation.** A HEALTHCHECK probing a port the app does not listen on is worse than an inconsistent number.
  REQUEST #68 reverses this.

- **`modules/environment` composes everything; `envs/dev` and `envs/staging` are thin wrappers.** Two
  environments that are literally the same module cannot drift apart in shape, which is what "reproducible from
  an empty account" actually requires. They differ only in sizes and a single `protect` flag.
- **The `platform_app` role is created by a Kubernetes Job, not by Terraform.** A Terraform-managed role would
  put its password in the state file and would drift on every `GRANT`. The Job also has to run *before* the
  migrations: `0001_app_schema.sql` creates the role with a local-dev password when it is missing, so creating
  it first is what keeps that password out of the cloud entirely. The Job re-applies the password on every
  sync, which is also the rotation path for 2.6.
- **Grants are not repeated in the bootstrap SQL.** `0009_rls_policies.sql` owns every GRANT/REVOKE for
  `platform_app`; duplicating them in infra would give the role's privileges two homes and one of them would
  rot. The Job only creates the role, sets the password, and asserts it is neither SUPERUSER nor BYPASSRLS.
- **Application secrets are generated by Terraform, not written into a tfvars file.** `.env.example` gained
  `JWT_SECRET`, `COOKIE_SECRET` and `ADMIN_SESSION_SECRET` with dev placeholders while 2.2 was parked; a cloud
  environment must never inherit those. They are `random_password` → Secrets Manager, and the `dotenv` output
  documents, inline, the four variables that are deliberately absent (`CORE_DEV_TOKENS` above all — it is a
  local auth bypass and setting it in a cloud environment would be a security hole).
- **Partial S3 backend (`backend "s3" {}` + `-backend-config=backend.hcl`).** Bucket and lock-table names are
  account-specific; keeping them out of git means the same code works for any account and no identifier leaks.
- **`.terraform.lock.hcl` is committed** (registry `zh:` hashes for all platforms, native `h1:` for linux).
  Generating native hashes for three platforms downloads ~700 MB and timed out here; the documented one-liner
  `terraform providers lock -platform=darwin_arm64` adds a platform when someone needs it.
- **ECR repositories are per environment** (`<env>/commerce-platform/<app>`, IMMUTABLE tags). Sharing one
  registry between environments would couple them; ECR storage is cheap and independence is the point.
- **Redpanda is not created in Terraform** — managed-first is a fixed decision, so only `kafka_brokers` and
  `schema_registry_url` are inputs. Recorded here because it looks like an omission otherwise.
- **EKS/RDS/ElastiCache over the managed-first alternatives** (Neon, Upstash): issue #32's acceptance criteria
  are authoritative and name them explicitly. The managed alternatives stay reachable as a values change
  because every consumer reads a `DATABASE_URL`/`REDIS_URL`, never a provider-specific resource.

- **The install layer copies each manifest explicitly; the `manifests` stage that used to collect them with
  `find` is gone.** It read better and it cached fine locally, but a remote cache matches `COPY --from` on
  the producing stage's key, so it never hit in CI (see Gotchas). The list of `COPY` lines is the thing
  that rots, so `infra/ci/check-image-manifests.sh` fails the build when a workspace package is added or
  removed without updating it.
- **CI uses `docker/bake-action`, not `docker compose build`.** Not a preference: `type=gha` needs
  `ACTIONS_RUNTIME_TOKEN`/`ACTIONS_CACHE_URL`, which are available to an action but not to a `run:` step.
  The alternative was a third-party action exporting them into the environment of a required check.
- **One GHA cache scope per image, accepting duplicated `deps` layers.** A shared scope would store the
  identical `manifests`/`deps` stages once, but six concurrent builds writing one last-write-wins scope
  would clobber each other exactly when it matters. Duplicated storage is the cheaper failure.
- **Jobs always run and skip their steps; no job-level `if`.** A skipped job reports a different conclusion
  to branch protection than a successful one, and 2.4b has to document required checks.
- **The `changes` classifier is a script with a self-test, not inline YAML.** Mirrors
  `scripts/check-ownership.sh` + `.test.sh`. A wrong answer is expensive both ways: a false negative skips
  the tests that would have caught a bug, a false positive gives back the 13-minute image build.

- **On a PR, `images` fires only on what defines how an image is built, not on app source.** Rebuilding six
  images because one source file moved was ~10 minutes of runner time per push, and it ran out the month's
  GitHub Actions budget on 2026-09-07. A push to main still builds everything, so the coverage moves from
  "every PR" to "at merge" rather than disappearing. Cost is a real constraint here, not an afterthought.

- **One chart for five apps, not five charts.** They are the same shape — a stateless container serving
  `$PORT` with a health path — and five charts that start identical drift. What genuinely differs (the mocks
  take their document as an argument and mount it from a ConfigMap) is values, not a forked chart.
- **The AppProject lists permitted kinds explicitly and allows no cluster-scoped ones.** An app-of-apps means
  a commit can create Applications; without a project boundary that is unrestricted cluster access one merge
  away. Cluster-scoped objects (the `ClusterSecretStore`, CRDs) are bootstrap, not sync.
- **dev self-syncs, staging does not.** A release should be an action someone took and can point at, not a
  side effect of a merge landing while nobody was looking.
- **The Prism specs come from a ConfigMap built out of `packages/contracts/openapi`, not copied into the
  chart.** Helm cannot read files outside a chart directory, and copying frozen contracts would give them a
  second home that silently rots.

- **A probe that answers 401 is a failing probe.** Kubernetes counts only 200-399 as success, so an httpGet
  probe against a Prism mock holds readiness red and lets liveness restart a healthy pod — CrashLoopBackOff
  from a container that was fine. The mocks use `tcpSocket` (listening IS the health of a static mock) and the
  ALB gets `success-codes: '200-399,401,404'`, because an ALB target group has no TCP health check.
- **Third-party images are pinned by digest, ours by git sha.** `stoplight/prism:5` is a moving tag: the same
  tag can be republished over a different manifest, so two syncs of one commit can run different code — the
  `latest` failure, just slower. CI knows the git sha before it knows the digest, which is why our own images
  cannot use the same rule.
- **A values file with no `env:` is not "no configuration", it is localhost.** Every app falls back to its
  local defaults, which inside a pod means itself. The non-secret half of `.env.example` has to be filled in
  per app per environment; only the secret half comes from the ExternalSecret.

- **Migrations belong to the deploy, not to a runbook.** A runbook step gets skipped exactly once — on the
  deploy that needed it. As an ArgoCD PreSync hook it runs every sync, from the same image as the app, and a
  failure stops the rollout rather than letting code meet a schema that has not caught up.
- **Helm cannot hash a secret it never sees.** `checksum/<x>` over values covers configuration in git and
  nothing else; External Secrets writes the actual value at run time. Rotation needs a watcher (Reloader) or a
  manual `kubectl rollout restart`. The previous comment claimed otherwise, which is worse than no comment.
- **A deploy workflow that fails when it is not configured teaches people to ignore a red main.** The staging
  deploy is a no-op that names the five missing settings and exits 0.

- **An app-of-apps with selfHeal makes `argocd app set` pointless.** It writes helm parameters onto the live
  Application CR, which ArgoCD then reconciles back to git and strips. Anything that must survive a sync has to
  be in git — for the deployed image that means committing `image.repository` and `image.tag`, not just the
  tag: a correct tag on a placeholder repository is equally unpullable.
- **Never write a CI-skip token in prose in a commit message.** GitHub matches `[skip ci]` anywhere in the
  commit message, body included — so a commit that *explains* the marker skips its own pipeline. My fix for
  #98 did exactly that: the push landed, no run was created, and `gh pr checks` said "no checks reported",
  which reads like an outage rather than a self-inflicted skip. Refer to it as "the skip marker" in prose, or
  break the token up.
- **Machine edits to committed YAML must preserve formatting.** `yq -i` re-emits the document and drops blank
  lines; a `[skip ci]` deploy commit then breaks `format:check` on somebody else's PR. Replace the lines
  (`infra/ci/set-image.mjs`) and assert nothing else moved.
- **Branch protection is unavailable on this repo** (private, free plan; the API returns 403). The nine
  required checks are documented for when it can be enabled, and `deploy-staging.yml` will then need a bypass
  allowance because it pushes to main.

- **A dashboard that renders is not a dashboard that works.** Tempo's span-metrics processor promotes no
  resource attributes by default, so `store_id` was absent from every series and all three per-store panels
  would have been empty while looking healthy. The label is also `service`, not `service_name`. Both found by
  posting a span and reading the label set back out of Prometheus — nothing short of running it would have
  caught either.
- **Grafana provisioning does not understand `${VAR:-default}`.** It expands environment variables but not
  bash-style defaults, and authenticates with the literal string. Plain `$VAR`; put the default in compose.
- **The observability stack is off by default and must stay that way.** `profiles: ['observability']` on all
  five services; `infra/observability/check.sh` asserts it, because "pnpm dev unchanged" is an acceptance
  criterion that a stray edit could quietly break.

- **`<env>` is the first path segment of every secret.** It turns the IAM policy into a prefix rather than a
  pattern, so the External Secrets role in staging is structurally unable to read dev's secrets. The cost is
  duplicating anything genuinely shared across environments, which is the right trade for a blast radius.
- **Use the gitleaks CLI, not gitleaks/gitleaks-action.** The action needs `pull-requests: write` to post
  findings as a comment and dies with `403 Resource not accessible by integration` without it — and a PR
  comment quoting a finding republishes the very credential that leaked. The container CLI needs no API
  access at all. `gitleaks git .` scans history; `gitleaks dir .` scans files.
- **A secret scan must not be path-filtered.** A filter only guarantees that the one PR adding a key to an
  unwatched directory is the one that is not scanned. It also has to scan history: a credential committed and
  then "removed" later is still in every clone.
- **gitleaks allowlist regexes match the extracted SECRET, not the reported MATCH.** They differ — match
  "access, analyst/finance/operations ", secret "analyst/finance/operations". Anchoring on the match
  allowlists nothing and looks like the config is being ignored. Read the `Secret` field of a JSON report.

- **Discovery globs must cover `apps/storefronts/*` as well as `apps/*`.** Brand storefronts live one level
  deeper (window 10 owns `apps/storefronts/<brand>/**`). Three of my scripts assumed `apps/*`; the worst was
  `run-e2e.sh`, which silently never ran brand-a's Playwright journey even though the app ships a config and an
  `e2e` script. A discovery bug in a test runner reports fewer passes, not a failure.
- **`paths-ignore` and required checks do not mix on `pull_request`.** A workflow that does not run reports no
  status at all, so a docs-only PR would sit on "Expected — waiting for status" forever under branch
  protection. On `push` it is free money; on `pull_request` it is a merge deadlock.
- **CI never loaded Medusa's runtime until the boot smoke.** `medusa build`, the unit tests and the image smoke
  test all pass while the server cannot start — proven on the first run (REQUEST #207: `apps/core` does not
  declare `@medusajs/draft-order`, which pnpm therefore does not link into `apps/core/node_modules`, and
  Medusa's plugin loader resolves it from the app directory).

- **A boot smoke needs a realistic database, and its own one.** Core runs a readiness check at start, so
  booting against an empty database fails for a boring reason and proves nothing about Medusa's loaders.
  `boot-smoke.sh` creates `platform_boot_smoke`, migrates, seeds and Medusa-migrates it, and drops it after —
  never the shared `platform` database. `loadDotenv()` never overrides an exported variable, which is what
  makes redirecting every URL at the throwaway database safe.
- **Images run with `NODE_ENV=production`, so app production guards fire at container start.** `feeds` exits
  without `FEEDS_STORE_CODES`. The image smoke test did not catch it because it checks real apps for build
  output only, not boot. Required runtime env belongs in the image contract table; never bake a default for a
  value whose absence is a deliberate guard.

- **Opt-in beats silent skip when a known external blocker would keep a job red.** Brand storefront journeys
  are behind `E2E_INCLUDE_BRAND_STOREFRONTS=1` until REQUEST #212 (Keycloak redirect URI for the brand port).
  The script prints the journeys it skipped, so "not run" never reads as "does not exist".
- **Killing a background shell does not kill its children on Windows.** Stopping a run of `run-e2e.sh` left a
  Playwright runner and `next start` alive, holding a port. After stopping one, check for processes whose
  command line contains the worktree path and stop them.

- **On Windows, check a port against `netsh interface ipv4 show excludedportrange protocol=tcp`, not just
  against listeners.** With the dynamic range starting at 1024, WinNAT reserves random blocks below 15000 that
  move on every restart; a free port today can be forbidden tomorrow. 3001 broke OpenFGA, and the replacement
  first agreed (3081) was already reserved. Fixed ports for new services go above 15000 (OpenFGA playground
  is now 18083).

## Blocked / waiting

- **REQUEST #92** (main) — `.prettierignore` must skip `infra/helm/*/templates/`. **Blocking 2.3**: Helm
  templates are Go templates, not YAML, and `prettier --check .` fails to parse them, so `format:check` and
  the whole `lint + typecheck` job go red. No in-chart workaround exists (prettier reads only the root
  ignore file); the alternative is renaming templates to `.yaml.tpl`, which breaks Helm convention.
- **REQUEST #60** (window 1) — `apps/core` must declare `ts-node`; until then the core image installs it in the
  build stage. Not blocking.
- **REQUEST #68** (windows 3 and 4) — Next.js `start` scripts should honour `$PORT`, and
  `storefront-starter/next.config.ts` breaks `next start` in a production image (it needs `typescript` at
  runtime and `--prod` drops it). The port half is worked around; **the config half is not, and will fail on
  the first staging deploy** — CI cannot catch it because the smoke test does not boot Next.js apps.
- **REQUEST #55** (main) — `.prettierignore` needs `**/.terraform`. Filed with the parked 2.2 work; re-check it
  is still open when 2.2 is un-parked.
- Cloud credentials (AWS, Grafana Cloud, Sentry, Vault) — until the owner puts them in `.env`, tasks 2.2/2.5/2.6
  stop at `terraform validate` / `helm template` / runbooks. Never commit credentials.

## Gotchas learned

- **LHCI prints metric values only for FAILED assertions**, and the default `optimistic` aggregation compares the
  BEST of the runs (min for `max*`). A green perf leg tells you only that one of three runs got under the line.
- **Re-running one job copies the other jobs into the new attempt with NEW job ids and identical logs** — do not
  count those as extra measurements (dedupe by log content).

- **Commit messages: never close/fix/resolve next to a `#number`** (GitHub closing keywords), unless the commit
  really finishes that issue. #347's subject "fixes #344's wrong fix" was flagged — say "corrects" / "follow-up to".
- **Ordering two suites is not a separation for single-use codes.** A helper that falls back to the current
  TOTP code spends exactly what the next suite needs. Separate by a step GAP computed from the clock
  (`infra/ci/totp-barrier.sh`), and get evidence from the server's own event log, not from one green run.
- **The owner's dev TOTP is a shared, single-use resource inside one CI job.** Keycloak refuses a reused code.
  auth-sdk's `keycloak-realms.test.ts` spends the current and next 30 s windows; core's `auth-live` helper tries
  previous → current → next. Run core's live suites FIRST (they spend only the previous window). Any new suite
  that signs `owner` in must be ordered with this in mind (#344).
- **`node --test <directory>` is not portable.** Node 20.19 on the laptop accepts it; the runner's preinstalled
  Node (jobs without setup-node, e.g. `helm`, `changes`) takes it as a module path. Always pass the test file.
- **A fresh-seed CI database has no orders.** Specs written against a laptop's long-lived shared database can
  assume rows that `pnpm db:seed` never creates (#341 run 2). Read the failure report's page snapshots
  (`gh run download … -n <report>`; the `data/*.md` files are aria snapshots) before blaming the job.

- **`PERF_PORT` is not honoured by Lighthouse.** `apps/storefront-starter/lighthouserc.json` hardcodes
  `127.0.0.1:3100`; `perf.mjs` starts `next start` on `PERF_PORT` but Lighthouse still audits :3100. Locally
  3100 is usually another window's dev server → CHROME_INTERSTITIAL_ERROR. On CI it is irrelevant (3100 free,
  PERF_PORT unset). Window 3's file — reported to the manager, not edited.
- Enforced required checks are a GitHub setting (five today). The `perf` job always runs and reports success
  when skipped, so it is safe to add to the enforced list — that is the owner's click, not this window's.

- **NEVER `docker compose down` or recreate containers in this worktree.** The docker stack is SHARED with
  every other window and with the integrator. During 2.5 I ran `down -v` to test a clean Keycloak import and
  took the stack out from under the integrator mid-test; the manager had to restore it with `pnpm dev`. Adding
  a profile's services with `up -d` is fine — it does not touch what is already running. If a test genuinely
  needs a clean volume, ask first. `--force-recreate` on a single service is the most that is ever acceptable,
  and only for a service no one else uses.

- **A `str.replace()` that finds nothing fails silently, and that is how the memory header went three updates
  out of date** before the #69 review caught it — each edit targeted wording a previous edit had already
  changed. Assert the target text exists before replacing it, and re-read a file before editing it rather than
  trusting what it said two edits ago.

- **corepack cannot be used in the runtime stage.** `pnpm deploy` writes a `package.json` with no
  `packageManager` field, so a corepack shim resolves "latest", tries to download pnpm from npm on container
  start, and dies with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` — and `corepack prepare --activate` in an
  earlier stage does not help, because its cache lives in root's `~/.cache` while the container runs as `node`.
  Use `npm install -g pnpm@<version>`. Caught only by testing the `start`-script branch of the entrypoint with a
  mounted `package.json`; the scaffold path (no `start` script) hides it.
- **PR flow (manager rule, 2026-09-05; also in Memory-main global gotchas).** GitHub allows one open PR per branch.
  Keep the single branch `infra/phase2`: finish a task → open a PR → **wait for the manager to merge it** (merge
  commit) → continue on the same branch → open the next PR, which then contains only the new task. Never create
  stacked per-task branches. Practical consequence: do not push task N+1 commits to `infra/phase2` while task N's
  PR is still open, or they land in that PR.
- **The `images` job takes ~12 minutes on a clean runner** now that three real apps are built (it was 2m23s
  with six scaffolds). Nothing is cached between runs yet — task 2.4 (#34) should add a registry or GHA build
  cache for the `pnpm install` and `pnpm build` layers, or this becomes the slowest required check by far.
- **A remote build cache does not match `COPY --from=<stage>` on content — it matches on the producing
  stage's cache key.** A `manifests` stage that does `COPY . .` to find the package.json files therefore gets a
  new key on any repo change, and the `pnpm install` layer beneath it misses every time, even though the
  manifests are byte-identical. It caches perfectly with a LOCAL cache, which is exactly how it passed local
  testing and then failed in CI. Copy manifests straight from the build context, one `COPY` per package, and
  guard the list with a script.
- **Exporting a `mode=max` GHA cache is expensive**: measured 60–145s "preparing build cache for export" plus
  14–37s "sending", per image, six images. It was the largest component of a 14-minute run. Export on pushes to
  main only; let pull requests read.
- **A playwright config's `webServer` builds the app, not the workspace packages it imports.** On a clean
  runner the storefront build fails with "Can't resolve '@platform/ui'". Build the dependencies first with
  turbo's dependencies-only filter, `--filter='<pkg>^...'` — the trailing `^...` means "the deps, not the
  package". Third time this family of gotcha has bitten: `pnpm --filter <app> build` in the Dockerfiles,
  `pnpm --filter <pkg> test` for vitest, and now the e2e web server.
- **A local Keycloak keeps its realms in a volume and does NOT re-import them.** `KC_DB: dev-file` plus the
  `keycloak-data` volume means edits to `infra/keycloak/*.json` are invisible until
  `docker compose down -v`. Four live auth tests failed against my stale realm and all 51 passed after a
  wipe — I nearly filed that as a broken suite. CI is unaffected: a runner always starts empty.
- **The live auth suites skip themselves silently.** They are `describe.runIf(await reachable())`, which is
  right on a laptop and dangerous in CI: a mis-wired URL yields a green job that asserts nothing. Hence
  `infra/ci/wait-for-auth-stack.sh`, which fails the job before vitest gets to decide.
- **`packages/auth-sdk/vitest.config.ts` also collects `apps/core/src/modules/hq-rbac/test/**`.** One
  command runs both suites; do not add a second step for core.
- **Run package tests through turbo, not `pnpm --filter <pkg> test`.** `dependsOn: ["^build"]` only applies
  through turbo, so a direct filter run tests against workspace packages that have no `dist/`. Same trap as
  `pnpm --filter <app> build` in the Dockerfiles.
- **Prettier does not read nested `.gitignore` files.** `apps/*/test-results/` is git-ignored by the app's
  own `.gitignore`, and `pnpm format:check` still fails on it after running the journeys (REQUEST #86).
- **Do not discover workspace packages with `find ... -name package.json`.** It picks up build output —
  `apps/storefront-starter/.next/package.json` is written by `next build` — and a denylist of build
  directories rots. `pnpm -r list --depth -1 --json` is authoritative.
- **`pnpm install --frozen-lockfile` after every `git pull`.** Three separate red herrings this phase
  (`ajv`/`yaml`, `@playwright/test`, `jose`) were all a stale local store while other windows added
  dependencies.
- **A git sha can be all digits, and YAML reads that as a number.** `eq .Values.image.tag "latest"` then dies
  with "incompatible types for comparison". Quote tags in values files AND `toString` them in the template —
  `helm lint` found this on a placeholder of forty zeroes.
- **kubeconform skips CRDs silently unless given a schema location.** `ExternalSecret` and ArgoCD
  `Application` would report "Skipped" and the check would pass having validated nothing that matters. Pass
  the datree CRD catalogue as a second `-schema-location`, and use `-strict` so unknown fields fail.
- **`docker buildx bake` resolves a target's `context` relative to the working directory, not to the file
  that declares it.** `context: ../..` in `infra/docker/docker-compose.build.yml` therefore means the repo root
  only when bake runs from `infra/docker`; from the repo root it looks for `../../apps` and fails with
  `ERROR: resolve : lstat ../../apps: no such file or directory`. `docker compose build` uses the opposite
  rule (relative to the compose file), which is why the local command never noticed. Fix:
  `workdir: infra/docker` in `docker/bake-action`.
- **`bake --print` does not resolve contexts**, so it happily prints a configuration that cannot build. It
  validates merging and syntax, nothing more — only a real build validates the context. Caught in CI after a
  green `--print` locally.
- **`pnpm deploy` drops dot-directories.** It packs like npm, and npm's rules skip them — so `.medusa/server`
  and `.next` never reach the deployed package and the container dies with MODULE_NOT_FOUND (core) or serves
  nothing (Next.js). Every real app needs an explicit `cp -r` after the deploy step. `dist/` is unaffected.
- **`pnpm --filter <app> build` does not build workspace dependencies.** Use `--filter "<app>..."` (trailing
  `...`), or the app compiles against packages with no `dist/`: "Cannot find module '@platform/db'".
- **`medusa build` requires `ts-node` and a populated environment.** The CLI does a bare `require('ts-node')`,
  so no loader flag (`--import tsx`, `--require tsx/cjs`) can substitute, and `NODE_ENV=production` only makes
  it fail differently. `medusa-config.ts` also throws on missing `DATABASE_URL_APP` / `REDIS_URL` /
  `JWT_SECRET` / `COOKIE_SECRET`, and nothing calls `loadDotenv()` on the CLI path — an image build has no
  `.env`, so the build stage must supply placeholders.
- **Git Bash on Windows rewrites absolute POSIX paths in any argument**, not just `-v` mounts:
  `docker run --entrypoint node img -p 'require("/app/package.json")'` reaches the container as
  `C:/Program Files/Git/app/package.json`. Use relative paths (WORKDIR is `/app`) or `MSYS_NO_PATHCONV=1`.
- **A container that has exited answers nothing.** `docker exec ... id -u` errors, which the first version of
  the smoke test read as "root". Use `docker image inspect -f '{{.Config.User}}'` — a property of the image,
  true whether or not anything is running.
- **A `.terraform` directory in the repo breaks `pnpm format:check`.** Provider binaries are ~710 MB per
  environment; prettier walks them and dies with `Invalid string length` plus a misleading "code style issues
  in 2 files". `infra/terraform/check.sh` sets `TF_DATA_DIR=~/.cache/commerce-platform-terraform` so this never
  happens on the normal path; a manual `terraform init` still creates one — delete it before `format:check`.
  REQUEST #55 asks main for the `.prettierignore` line.
- Terraform is not installed on this machine; `infra/terraform/check.sh` falls back to the
  `hashicorp/terraform` Docker image, which is also why the committed lock file has a linux-only native hash.
- `terraform providers lock -platform=... -platform=... -platform=...` downloads a full provider zip per
  platform (~700 MB for AWS) and will time out on a slow link. Do it once, deliberately, not in a loop.
- `aws_elasticache_replication_group` needs `automatic_failover_enabled = false` when there are no replicas;
  driving both it and `multi_az_enabled` off `replica_count > 0` keeps dev and staging on one code path.
- An AWS account may hold only **one** GitHub OIDC provider. The second environment in the same account must
  set `create_github_oidc_provider = false` or the apply fails with EntityAlreadyExists.
- `pnpm deploy` in pnpm 10 needs `--legacy` unless the workspace sets `inject-workspace-packages=true`.
- Windows/Git Bash: `docker run -v` needs `MSYS_NO_PATHCONV=1` and a `C:/…` path or the mount path is mangled.
- Prettier formats `infra/**` (only `docs/**` is ignored), so every YAML/Markdown/mjs file added here must be
  run through `npx prettier --write` or `pnpm format:check` fails in CI.
- ESLint runs over `infra/**/*.mjs` with `--max-warnings 0` and `no-console` is a warning outside `scripts/**`:
  use `console.info`.
- The scaffolds have no `start` script and only devDependencies, so `--prod deploy` yields a package with no
  `node_modules` at all — fine, and it means image size grows only when the real apps land.

## How to run & test this package

```bash
docker compose -f infra/docker/docker-compose.build.yml build      # all six images
docker compose -f infra/docker/docker-compose.build.yml build core # one
bash infra/docker/smoke-images.sh                                  # non-root + HEALTHCHECK + /health
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check      # repo gates
bash scripts/check-ownership.sh                                    # ownership gate
```
