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

  **What the smoke test does and does not prove.** `infra/docker/smoke-images.sh` reads each image's deployed
  `package.json` and checks accordingly — it does not keep a list of which app is which.

  |                                                        | scaffold (`accounting`, `analytics-ingest`, `notifications`) | real app (`core`, `admin`, `storefront-starter`) |
  | ------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------ |
  | non-root                                               | yes, read from the image's `Config.User`                     | same                                             |
  | build output present under `/app`                      | n/a                                                          | yes — `.medusa/server`, `.next` or `dist`        |
  | `HEALTHCHECK` reaches `healthy`, `/health` returns 200 | yes                                                          | **no — not attempted**                           |

  A scaffold is self-contained, so it is held to a real health check. A real app is deliberately not booted:
  `apps/core` throws without `DATABASE_URL_APP` and `apps/admin` without `ADMIN_SESSION_SECRET`, and that is
  correct fail-fast behaviour rather than something to work around. An image test that stood up Postgres and
  Redis, ran two sets of migrations and invented secrets would be testing the deployment — slowly, and flakily.
  Proving that a _configured_ app serves `/health` belongs to the staging deploy (tasks 2.3/2.4).

  What it does catch is the failure that caused issue #59: `pnpm deploy` drops dot-directories, so `.medusa`
  and `.next` never reached the deployed package and two images shipped no application at all while still
  building green.

  The `images` CI job builds all six and runs the smoke test; see the CI pipeline section below for when it
  runs and how it is cached. It never pushes.

- `keycloak/` — realm exports. Phase 0 ships local-dev stubs (7 staff users, one customer); window 2 replaces them (MFA, SSO, mappers).
- `openfga/` — authorization model (`model.fga`) and seed tuples. Window 2 (the frozen relation names are in docs/adr/0002-auth-model.md).
- `redpanda/` — topic definitions and schema registry config. Window 14.
- `kubernetes/` — raw manifests that are not part of a chart. Today: `bootstrap-db/`, the Job that creates the
  `platform_app` database role. See `kubernetes/README.md`.
- `terraform/` — AWS `dev` and `staging`. Window 5.
- `helm/` — one chart, instantiated per app per environment. `argocd/` — the Applications that do it.

## Helm

```
helm/
  platform-app/            the chart: Deployment, Service, Ingress, ServiceAccount, ExternalSecret, HPA
  values/<app>/values-<env>.yaml   what differs: image, port, hostname, replicas, which secrets
  check.sh                 helm lint + helm template + kubeconform, no cluster needed
argocd/
  projects/commerce-platform.yaml  the AppProject — the blast radius
  app-of-apps.yaml                 the one Application an operator creates by hand
  applications/<app>-<env>.yaml    one per app per environment, created by the app-of-apps
```

**One chart, not five.** `core`, `admin`, `storefront` and the two Prism mocks are the same shape: a stateless
container that serves `$PORT` and answers a health path — the contract the images already keep. Five charts
that start identical drift; one chart plus ten values files cannot. What genuinely differs (the mocks take
their document as an argument and mount it from a ConfigMap) is expressed in values, not in a fork of the
chart.

```bash
bash infra/helm/check.sh            # lint, render all ten combinations, validate with kubeconform
bash infra/helm/check.sh --render   # and print the manifests, for reading a diff by hand
```

Like `infra/terraform/check.sh`, it uses local binaries when they exist and the official images through Docker
otherwise, so a laptop with neither helm nor kubeconform installed can still run it. CI runs the same script.

**kubeconform is given the CRD catalogue**, not just the built-in Kubernetes schemas. Without it, the
`ExternalSecret` and ArgoCD `Application` objects would be "missing schema" and skipped — the check would pass
while saying nothing about the two object types most likely to be wrong. `-strict` also rejects unknown fields,
which is what catches a typo'd key.

**The chart refuses to render** without an image repository, an image tag, or an ingress host, and refuses the
tag `latest` outright: ArgoCD syncs a tag, so a moving tag means the cluster and the repository disagree about
what is running. Tags are git shas, set by the deploy workflow (task 2.4b).

**Secrets are never in a values file.** Terraform generates them into AWS Secrets Manager (task 2.2); the
chart's `ExternalSecret` names the remote key; External Secrets Operator projects it into a Kubernetes Secret
that the Deployment consumes with `envFrom`. A values file lists _which_ secrets an app needs, never what they
are. An app with none sets `externalSecrets.enabled: false` rather than projecting an empty Secret — the chart
fails the render if that is inconsistent.

**dev self-syncs, staging does not.** dev is disposable and a drifting dev cluster teaches nobody anything.
staging is released by the deploy workflow bumping an image tag and triggering a sync, so a release is
something someone did and can point at, rather than a side effect of a merge landing while nobody was looking.

## Runbook: bootstrapping ArgoCD on a fresh cluster

Continues from the Terraform runbook below, once `terraform apply` has produced a cluster. Nothing here has
been run against a real account yet — there is no account.

**1. Point kubectl at the cluster.**

```bash
cd infra/terraform/envs/dev
aws eks update-kubeconfig --name "$(terraform output -raw cluster_name)"
```

**2. Install ArgoCD.**

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.2/manifests/install.yaml
kubectl -n argocd rollout status deploy/argocd-server --timeout=5m
```

**3. Install External Secrets Operator and point it at Secrets Manager.** The charts assume a
`ClusterSecretStore` named `aws-secrets-manager`; it is cluster-scoped, so it is bootstrap, not something a
sync may create (the AppProject forbids cluster-scoped objects deliberately).

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace --wait
# The store authenticates with the cluster's IRSA provider — terraform output oidc_provider_arn.
kubectl apply -f - <<'EOF'
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata: { name: aws-secrets-manager }
spec:
  provider:
    aws:
      service: SecretsManager
      region: eu-central-1
      auth:
        jwt:
          serviceAccountRef: { name: external-secrets, namespace: external-secrets }
EOF
```

**4. Give the mocks their documents.** The Prism charts mount `contracts-openapi`. It is created from
`packages/contracts/openapi` rather than copied into the chart, so the frozen contracts keep one home:

```bash
kubectl create namespace commerce-dev
kubectl create configmap contracts-openapi -n commerce-dev \
  --from-file=packages/contracts/openapi/ --dry-run=client -o yaml | kubectl apply -f -
```

**5. Create the project and the app-of-apps.** These two are the only manual `kubectl apply`s; everything
else is a file in this repository from here on.

```bash
kubectl apply -f infra/argocd/projects/commerce-platform.yaml
kubectl apply -f infra/argocd/app-of-apps.yaml
kubectl -n argocd get applications
```

**6. First sync.** dev syncs itself. staging is deliberately manual:

```bash
argocd app sync core-staging          # or the Sync button in the UI
```

**Rolling back a deploy.** ArgoCD keeps the history; roll back to the previous synced revision, which is a
previous image tag:

```bash
argocd app history core-staging
argocd app rollback core-staging <revision>
```

**Getting the admin password** (change it, then delete the secret):

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

- `ci/` — the pieces of `.github/workflows/ci.yml` that are worth testing on their own.
  `changes.sh` decides which job groups a change needs (`code`, `images`, `terraform`) and
  `changes.test.sh` is its self-test, which the `changes` job runs before trusting it — the same
  arrangement `scripts/check-ownership.sh` and its `.test.sh` use. `check-image-manifests.sh` keeps
  the per-package `COPY` lists in the Dockerfiles complete. Keeping the rules in scripts rather than
  inline YAML is what makes them testable:

  ```bash
  bash infra/ci/changes.test.sh                                  # 18 cases
  CHANGED_FILES='apps/core/src/x.ts' bash infra/ci/changes.sh    # try one by hand
  ```

## CI pipeline

`.github/workflows/ci.yml`. `ownership` is first and stays first; `scripts/check-ownership.sh`
belongs to the main window.

| job              | runs when   | what it does                                                                                              |
| ---------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `ownership`      | always      | `check-ownership.sh` + its self-test                                                                      |
| `changes`        | always      | classifies the diff into `code` / `images` / `terraform` / `e2e` / `helm`                                 |
| `lint-typecheck` | `code`      | lint, format, typecheck, generated-file drift                                                             |
| `unit`           | `code`      | `pnpm test` with Postgres, then migrate + seed                                                            |
| `contract`       | `code`      | `pnpm test:contract` against Prism                                                                        |
| `images`         | `images`    | builds all six images through bake, then `smoke-images.sh`. Never pushes                                  |
| `auth-e2e`       | `e2e`       | Keycloak (both realms), OpenFGA and Postgres from compose; the live auth suites; every Playwright journey |
| `helm`           | `helm`      | `infra/helm/check.sh` — lint, render every app/env, kubeconform                                           |
| `terraform`      | `terraform` | `infra/terraform/check.sh`                                                                                |
| `preview`        | PRs         | placeholder until 2.4b                                                                                    |

**`images` is narrower on a PR than `code` is.** A source change under `apps/**` or `packages/**` no longer
rebuilds the six images: only a `Dockerfile`, `.dockerignore`, `infra/docker/**`, `infra/ci/**` or a
workspace-root manifest does. A push to `main` always builds everything, so an app change that breaks its own
image is caught at merge. This is a deliberate cost trade — the six-image build is ~10 minutes of runner time
and it was running on every push to every branch, which exhausted the month's Actions budget.

**Every job always runs; only its expensive steps are skipped.** A job skipped by a job-level `if`
reports a different conclusion to branch protection than a successful one, and required checks are
much easier to reason about when every job always reports success. The cost is a few seconds of
runner startup; the saving is the install, the test run and the image build.

**Caching.**

- Images: `infra/docker/docker-bake.hcl` adds a GitHub Actions build cache (`type=gha`, one scope
  per image, `mode=max`) on top of `docker-compose.build.yml`. CI drives it with
  `docker/bake-action` rather than `docker compose build`, because the cache backend needs
  `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_CACHE_URL`, which GitHub gives to an action but not to a
  plain `run:` step. Locally, `docker compose build` is unchanged and needs no flags.
- The Dockerfiles install dependencies in a `deps` stage that copies **only** the `package.json`
  files and the lockfile, straight from the build context. Sources arrive afterwards, so a
  source-only change reuses the install layer instead of redoing `pnpm install`.
  The manifests are listed one `COPY` per package rather than collected by a `find` stage, which
  reads better but does not survive a remote cache: `type=gha` matches `COPY --from=<stage>` on the
  producing stage's cache key, and that stage has to copy the whole context in order to search it,
  so any repo change invalidated the install. `infra/ci/check-image-manifests.sh` fails the build if
  a workspace package is added or removed without updating the list.
- **Pull requests read the image cache; only pushes to main write it.** Exporting cost 60–145s of
  "preparing build cache for export" plus 14–37s of "sending" per image — measured, it was the
  largest single component of the run. A PR that changes a dependency pays for one slow install
  rather than making every other PR pay to export it.
- Node jobs: `actions/setup-node` caches the pnpm store, and `actions/cache` keeps turbo's task
  output so an unchanged package skips its work entirely.

## Terraform

```
terraform/
  check.sh                    fmt -check + init -backend=false + validate for both envs (also the CI job)
  modules/
    environment/              composes everything below; this is what an env module block calls
    network/                  VPC, 3 AZs, public + private subnets, NAT, S3 gateway endpoint
    cluster/                  EKS, managed node group, IRSA OIDC provider, add-ons
    postgres/                 RDS Postgres 16, parameter group, Secrets Manager entries
    redis/                    ElastiCache Redis 7, transit encryption, auth token
    objects/                  S3 media + backups buckets
    ci-oidc/                  GitHub OIDC provider and the CI deploy role
  envs/dev/                   cheap: 1 NAT, single-AZ RDS, no Redis replica, nothing protected
  envs/staging/               production-shaped: NAT per AZ, Multi-AZ RDS, Redis replica, deletion protection
```

`dev` and `staging` are thin wrappers around `modules/environment`, so the two environments are provably the
same shape and differ only in size and safety flags. Small modules keep their variables and outputs in
`main.tf`; the larger ones (`network`, `cluster`, `postgres`) split into `variables.tf` / `main.tf` /
`outputs.tf`.

**Redpanda is not created here.** The fixed decision is managed-first, so the cluster is created in the
Redpanda Cloud console and only `kafka_brokers` / `schema_registry_url` are passed in as variables.

### What is checked without an AWS account

```bash
bash infra/terraform/check.sh          # fmt -check, init -backend=false, validate (dev + staging)
bash infra/terraform/check.sh --fix    # rewrite files with terraform fmt
```

The script uses a local `terraform` if there is one and otherwise the official Docker image, so it works on a
laptop with nothing installed. CI runs the same script in the `terraform` job. `terraform plan` and `apply`
need credentials and stay manual until the owner provides an account — see the runbook below.

### Secrets and state

- No password is ever typed, written to a `.tfvars` file, or committed. Terraform generates the RDS and Redis
  credentials with `random_password` and stores them in Secrets Manager under `<env>/platform/database/owner`,
  `<env>/platform/database/app` and `<env>/platform/redis`.
- State lives in an S3 bucket with a DynamoDB lock table, configured as a **partial backend**: the bucket and
  table names are passed with `-backend-config=backend.hcl`, so no account identifier is committed. State is
  never committed — `infra/terraform/.gitignore` blocks `*.tfstate*`, `.terraform/`, `*.tfvars` (except the
  `.example` files) and `*.tfplan`.
- `.terraform.lock.hcl` **is** committed. It carries registry (`zh:`) hashes for every platform plus a native
  (`h1:`) hash for linux. If your platform's hash is missing, add it once with
  `terraform providers lock -platform=darwin_arm64`.

### Outputs are `.env.example` variables

Every environment output is named after the variable it fills in `.env.example` — `DATABASE_URL`,
`DATABASE_URL_APP`, `REDIS_URL`, `KAFKA_BROKERS`, `KEYCLOAK_URL`, `OPENFGA_API_URL`, `MOCK_API_URL`,
`MOCK_ADMIN_API_URL` — so an application's configuration is identical locally and in the cloud. The whole file
can be produced at once:

```bash
cd infra/terraform/envs/dev
terraform output -raw dotenv > /tmp/dev.env   # contains secrets; never commit it
```

## Runbook: an empty AWS account → dev → staging

Everything below is a literal command. Nothing has been run against a real account yet: this task stops at
`validate`, as agreed, until credentials exist.

**0. Prerequisites.** An AWS account, `aws` CLI v2 logged in (`aws sts get-caller-identity` works), Terraform
≥ 1.9, and a Route 53 hosted zone for `base_domain`.

**1. Create the state backend, once per account.**

```bash
export AWS_REGION=eu-central-1 PREFIX=acme
aws s3api create-bucket --bucket "$PREFIX-tfstate" --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
aws s3api put-bucket-versioning --bucket "$PREFIX-tfstate" --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket "$PREFIX-tfstate" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$PREFIX-tfstate" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws dynamodb create-table --table-name "$PREFIX-tfstate-lock" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
```

**2. Bring up dev.**

```bash
cd infra/terraform/envs/dev
cp backend.hcl.example backend.hcl && $EDITOR backend.hcl              # bucket + lock table names
cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars  # base_domain, bucket_prefix
terraform init -backend-config=backend.hcl
terraform plan  -var-file=terraform.tfvars -out=dev.tfplan             # read it before applying
terraform apply dev.tfplan                                             # ~20 min, mostly EKS and RDS
rm -f dev.tfplan                                                       # a plan file is readable state
```

**3. Create the application database role.** The migrations create `platform_app` with a local-development
password only if it does not already exist, so the bootstrap Job must run first — that way the dev-default
password never exists in the cloud, not even briefly.

```bash
aws eks update-kubeconfig --name "$(terraform output -raw cluster_name)"
kubectl create namespace commerce

# Until External Secrets is wired (task 2.6), project the two secrets by hand:
aws secretsmanager get-secret-value --secret-id dev/platform/database/owner --query SecretString --output text \
  | jq -r 'to_entries|map("--from-literal=\(.key)=\(.value)")|join(" ")' \
  | xargs kubectl create secret generic platform-database-owner -n commerce
aws secretsmanager get-secret-value --secret-id dev/platform/database/app --query SecretString --output text \
  | jq -r 'to_entries|map("--from-literal=\(.key)=\(.value)")|join(" ")' \
  | xargs kubectl create secret generic platform-database-app -n commerce

kubectl kustomize infra/kubernetes/bootstrap-db | kubectl apply -n commerce -f -
kubectl wait --for=condition=complete --timeout=120s job/bootstrap-db -n commerce
kubectl logs -n commerce job/bootstrap-db
```

**4. Migrate and seed.** From a machine that can reach the database (a VPN, a bastion, or a one-off pod):

```bash
DATABASE_URL="$(terraform output -raw DATABASE_URL)" pnpm db:migrate
DATABASE_URL="$(terraform output -raw DATABASE_URL)" pnpm db:seed     # dev only
```

**5. Wire CI.** `terraform output -raw ci_role_arn` gives the role GitHub Actions assumes with OIDC. Set it as
the `AWS_ROLE_ARN` repository variable — there is no access key to store, and nothing to rotate.

**6. Staging.** Same steps in `envs/staging`, with one difference: if it shares the AWS account with dev, leave
`create_github_oidc_provider = false`, because an account may hold only one GitHub OIDC provider.

**Tearing dev down.** `terraform destroy -var-file=terraform.tfvars`. It succeeds because `protect = false` in
dev: no deletion protection and buckets are force-destroyable. In staging it will refuse, by design.
