# Memory 5 — Infra & DevOps

Window: 5 · Key: `infra` · Branch prefix: `infra/` · Model: Opus
Last updated: 2026-09-06 · Contracts: `contracts-v0.1` · Branch: `infra/phase2` · Worktree: `../wt-infra`
Status: 2.1 (#31) and 2.1b (#59) merged · 2.2 (#32) in PR #74, green, awaiting review · next up 2.4a (#34, caching) then 2.3 (#33)

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

- **2.4a — CI caching, path filters, and two review fold-ins (issue #34, first half)** — commits `e7fe27e`
  + `3c1e50d`, PR #81 (https://github.com/mfx1590/Commerce-Platform/pull/81), all eight checks green.
  Measured on the PR: `lint + typecheck` 1m47s → 49s, `unit` 2m28s → 58s, `contract` 50s → 40s once the turbo
  cache was warm.
  `infra/ci/changes.sh` + self-test replacing the two inline `git diff` filters; `infra/docker/docker-bake.hcl`
  (GHA build cache, one scope per image) driven by `docker/bake-action`; turbo task cache in the three node
  jobs; every Dockerfile split into `manifests` → `deps` → `build` so `pnpm install` no longer depends on
  source files. Plus `backend.hcl` ignored by name, and the bootstrap Job's credentials moved out of argv into
  the environment (`\getenv`).
  Verified locally: touching an app source file leaves `pnpm install --frozen-lockfile` `CACHED`; all six
  images rebuild and the smoke test passes; `changes.test.sh` 18/18; the bootstrap SQL was run twice against a
  real Postgres (create, then rotate) with a password containing a quote, and the test roles dropped after.

## In progress

- Nothing being written. 2.4a is in its PR; 2.3 (#33, Helm charts + ArgoCD) is next, then 2.4b.

## Next — Phase 2 (order = GitHub issues, authoritative)

- [ ] **#33 · 2.3** Helm charts (core, admin, storefront, Prism mocks) + ArgoCD app-of-apps; `helm lint`,
      `helm template`, `kubeconform` in CI; `values-dev.yaml` / `values-staging.yaml`; image tag = git sha.
- [ ] **#34 · 2.4b** (after 2.3) Playwright job hooks — `apps/storefront-starter` already has
      `playwright.config.ts` and `e2e/checkout.spec.ts` and nothing runs them; `deploy-staging.yml` on main
      (no-op with a clear log line until the ArgoCD secret exists); required-status-check documentation for
      branch protection. Depends on 2.3 for the charts and the ArgoCD app names.
- [ ] **#35 · 2.5** Observability: OTel collector + Grafana/Prometheus/Loki/Tempo as a
      `docker compose --profile observability` overlay, provisioned dashboards (per-store request rate, error
      rate, p95, outbox lag), Sentry DSN via env. Needs a `CONTRACT CHANGE:` issue for the read-only Postgres
      role the outbox-lag panel queries (do not write the migration).
- [ ] **#36 · 2.6** Vault / AWS Secrets Manager + External Secrets Operator, `secret/stores/<store_code>/…`
      naming scheme, `gitleaks` step in CI, `REQUEST:` issue for a new ADR, `infra/README.md` runbook covering
      bootstrap → dev → staging, rotate a secret, roll back a deploy.

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

- **The install layer is split with a `manifests` stage, not a hand-written list of `COPY` lines.** One
  `COPY apps/<name>/package.json` per package is the usual recipe and it rots the first time someone adds a
  workspace package without touching six Dockerfiles. `find` + `COPY --from` is content-checksummed by
  BuildKit, so it caches exactly as well and cannot go stale.
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

## Blocked / waiting

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
