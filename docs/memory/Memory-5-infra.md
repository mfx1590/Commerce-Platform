# Memory 5 — Infra & DevOps

Window: 5 · Key: `infra` · Branch prefix: `infra/` · Model: Opus
Last updated: 2026-09-24 · Contracts: `contracts-v0.1` · Branch: `infra/phase2` · Worktree: `../wt-infra`
Status: Phase 2 complete; reopened by REQUEST. **In flight:** REQUEST #257 (storefront SITE_URL, robots guard, perf CI job).
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

- **REQUEST #257** (window 3) — **PR #272 open** (code commit `69fad5e`, main merged incl. 08939a6's
  `.env.example` SITE_URL row). Awaiting its CI run (first real `perf` run; fix forward on the same PR if it
  reds environmentally) and the Reviewer. After merge the manager adds the `perf` job to required checks;
  Keycloak redirect URIs are in #212 (window 2); the PERF_PORT nit is routed to window 3.
  **Verdict MERGE-WHEN-GREEN.** First CI run red on SEO 0.69/0.58/0.58: `is-crawlable` (robots fail-closed,
  fixed by `ROBOTS_ALLOW_INDEXING: '1'` on the perf step) + a flaky `meta-description` that fails on runs 2-3
  of each URL, never run 1 (reproduced locally; server HTML has the tag on every request, so it is lost
  client-side; window 3's). Also fixed: upload-artifact@v4 skipped `.lighthouseci` (hidden) —
  `include-hidden-files: true`. Later-touch nits: check.sh treats `values-production.yaml` as non-prod (say so
  in the comment); Actions Node 20 deprecation warning. Contents:
  - `SITE_URL: 'https://shop.<env>.example.com'` in `infra/helm/values/storefront/values-{dev,staging}.yaml`
    (the urgent part: without it OIDC redirect_uri fell back to http://localhost:3100).
  - `infra/helm/check.sh` guard: storefront `SITE_URL == https://<ingress.host>`; `ROBOTS_ALLOW_INDEXING`
    `'1'` in values-prod.yaml only, absent elsewhere. No values-prod.yaml created (no prod env exists in
    terraform/argocd). Verified both directions with scratch copies; full check.sh green (10 combos).
  - CI job `perf` (window 3's A1 drop-in) gated on a new `perf` classifier group (A2 taken):
    `^(apps/storefront-starter/|packages/(ui|contracts)/|cms/)` + ROOT_FILES. Self-test 37 ok.
  - README (jobs table, perf paragraph, branch-protection list) + CHANGELOG.
  - Local run: turbo dep build ok, `next build` ok, bundle budget PASS; Lighthouse could not run locally
    (see Gotchas — port 3100 taken here). The PR's own CI run is the proof.

## Done (earlier)

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

Standing debts, whenever this window is next open:

- **REQUEST #207** (window 1) — `apps/core` cannot start on main; the new boot smoke step is red until it
  lands. Verified fix: declare `@medusajs/draft-order` as a dependency.
- **REQUEST #212** (window 2) — brand-a's Keycloak redirect URI; then set `E2E_INCLUDE_BRAND_STOREFRONTS` on by default.
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
