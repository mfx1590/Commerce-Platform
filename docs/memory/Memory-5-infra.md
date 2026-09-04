# Memory 5 — Infra & DevOps

Window: 5 · Key: `infra` · Branch prefix: `infra/` · Model: Opus
Last updated: 2026-09-04 · Contracts: `contracts-v0.1` · Branch: `infra/phase2` · Worktree: `../wt-infra` · Status: 2.1 merged? no — PR #45 open, all CI green; paused before 2.2 for owner confirmation

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
  (https://github.com/mfx1590/Commerce-Platform/pull/45), awaiting the Reviewer session. All six CI checks green,
  including the new `images` job (2m23s on a clean runner: six images built + smoke test).
  Six `apps/<app>/Dockerfile`, `infra/docker/{entrypoint.sh,health-server.mjs,docker-compose.build.yml,smoke-images.sh}`,
  CI job `images`, `infra/README.md` + `infra/CHANGELOG.md`.
  Verified locally: all six images build; smoke test green (uid 1000, HEALTHCHECK `healthy`, `/health` → 200);
  scaffold image ~221 MB (node:20-alpine + 24 MB pnpm; the app layers are ~100 KB).

## In progress

- **2.2 — Terraform AWS dev + staging (issue #32).** Plan written before starting; waiting for the owner's go-ahead
  (>20 tool calls, budget rule). No cloud credentials exist yet, so everything stops at `fmt -check` + `validate`
  plus a `plan` runbook.

  Layout:

  ```
  infra/terraform/
    modules/network/        VPC, 3 AZ, public + private subnets, single NAT (dev) / one per AZ (staging), VPC endpoints
    modules/cluster/        EKS (small, managed node group), IRSA OIDC provider, aws-auth, cluster autoscaler IAM
    modules/postgres/       RDS Postgres 16, subnet group, SG, parameter group (RLS-safe: no rds_superuser for the app)
    modules/redis/          ElastiCache Redis 7, replication group, SG
    modules/objects/        S3 media + backups buckets (versioned, SSE, public access blocked), lifecycle rules
    modules/ci-oidc/        GitHub OIDC provider + a deploy role scoped to this repo (no long-lived keys)
    modules/bootstrap-db/   k8s Job manifest + SQL that creates the `platform_app` role and grants (never by hand)
    envs/dev/               backend.tf (S3 + DynamoDB lock), main.tf, variables.tf, outputs.tf, terraform.tfvars.example
    envs/staging/           same, larger sizes, NAT per AZ, deletion protection on
  ```

  Rules to hold to:
  - Outputs must be named so they map 1:1 onto `.env.example`: `DATABASE_URL`, `DATABASE_URL_APP`, `REDIS_URL`,
    `KAFKA_BROKERS`, `KEYCLOAK_URL`, `OPENFGA_API_URL`. Redpanda is Redpanda **Cloud** per the managed-first
    decision: connection variables only, no cluster resource.
  - Remote state: S3 bucket + DynamoDB lock table, documented in the runbook and created by a one-off bootstrap;
    state is never committed and `.gitignore` already covers `*.tfstate`? — check, and if not, ask main (root config).
  - Secrets never in `.tfvars` in git; only `terraform.tfvars.example` with placeholders.
  - CI: new `terraform` job in `ci.yml` running `fmt -check -recursive` and `init -backend=false && validate` for
    both envs. No AWS credentials needed, so it runs on every PR touching `infra/terraform/**`.
  - Runbook section in `infra/README.md`: empty AWS account → bootstrap state → `plan` → `apply` for dev, then staging.

  Open question for the owner (does not block writing the code): EKS vs. the managed-first decision. Memory-main says
  managed-first for Phases 0–3 (Vercel, Neon, Upstash, Redpanda Cloud), but issue #32 asks for EKS + RDS +
  ElastiCache. I will follow the issue (EKS/RDS/ElastiCache) since acceptance criteria override, and keep the
  managed alternatives as documented variables so a later switch is a values change, not a rewrite.

## Next — Phase 2 (order = GitHub issues, authoritative)

- [ ] **#32 · 2.2** Terraform AWS dev + staging: VPC, EKS, RDS Postgres 16 (+ `platform_app` bootstrap job),
      ElastiCache Redis, Redpanda Cloud connection vars, S3, CI OIDC role. `fmt -check` + `validate` in CI,
      `plan` runbook only until credentials exist. Outputs must match `.env.example` names.
- [ ] **#33 · 2.3** Helm charts (core, admin, storefront, Prism mocks) + ArgoCD app-of-apps; `helm lint`,
      `helm template`, `kubeconform` in CI; `values-dev.yaml` / `values-staging.yaml`; image tag = git sha.
- [ ] **#34 · 2.4** CI: generalise path filters, pnpm + turbo caching, Playwright job hooks (gated on
      `apps/*/playwright.config.*`), `deploy-staging.yml` on main (no-op with a clear log line until the
      ArgoCD secret exists), branch-protection docs. Docs-only PR under 2 minutes.
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

## Blocked / waiting

- Cloud credentials (AWS, Grafana Cloud, Sentry, Vault) — until the owner puts them in `.env`, tasks 2.2/2.5/2.6
  stop at `terraform validate` / `helm template` / runbooks. Never commit credentials.

## Gotchas learned

- **corepack cannot be used in the runtime stage.** `pnpm deploy` writes a `package.json` with no
  `packageManager` field, so a corepack shim resolves "latest", tries to download pnpm from npm on container
  start, and dies with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` — and `corepack prepare --activate` in an
  earlier stage does not help, because its cache lives in root's `~/.cache` while the container runs as `node`.
  Use `npm install -g pnpm@<version>`. Caught only by testing the `start`-script branch of the entrypoint with a
  mounted `package.json`; the scaffold path (no `start` script) hides it.
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
