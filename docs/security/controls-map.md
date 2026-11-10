# Controls map (SOC2-lite)

Grouped by Trust Services Criteria area. This is a reading list for a future audit, not an audit. Vocabulary
(evidence, the four statuses, "required check") is defined in [`README.md`](README.md). CI job names are quoted
exactly from `.github/workflows/ci.yml`. "Required" marks the six checks GitHub enforces on `main`.

Windows are those of `docs/ownership.md` (1 core, 2 auth, 3 storefront, 4 admin, 5 infra, 7 payments, 10 brands,
12 data, 13 customers, 14 events and AI gateway, 15 accounting, 16 engagement; "main" is the manager; "owner" is
the human operator).

## 1. Access control (CC6)

| # | Control | How it is enforced | Evidence | Status | Owner |
|---|---|---|---|---|---|
| C-1 | Tenant isolation in the database | RLS enabled and forced on every tenant table; the app role is `NOBYPASSRLS`; context is transaction-local | `packages/db/test/rls.test.ts`; `packages/db/src/client.ts`; ADR 0001; job `unit tests (with Postgres, RLS)` (required) | enforced in CI | main |
| C-2 | No table left with RLS unforced by a migration | The migration runner refuses to commit it | `packages/db/src/migrate.ts`; `packages/db/test/managed-postgres-migrations.test.ts`; same job (required) | enforced in CI | main |
| C-3 | Least-privilege database roles | `platform_app` for apps, owner for migrations only; `platform_metrics` may only EXECUTE `app.outbox_lag()`; `platform_outbox_lag` is NOLOGIN, six columns, unpublished rows; the managed migration role is neither superuser nor BYPASSRLS | `packages/db/migrations/0110_metrics_role.sql`; `packages/db/migrations/0208_outbox_lag_owner_role.sql`; `packages/db/test/metrics.test.ts`; `packages/db/test/managed-postgres-migrations.test.ts`; `infra/kubernetes/bootstrap-db/bootstrap.sql` | enforced in CI | main |
| C-4 | Append-only history tables | No UPDATE/DELETE grant for the app role on `audit_log`, `stock_movement`, `ai_call_audit`, `customer_consent` (no UPDATE) | `packages/db/CLAUDE.md` "Rules every consumer must follow"; `packages/db/test/ai-call-audit.test.ts`; `packages/db/test/rls.test.ts` | enforced in CI | main |
| C-5 | Staff identity: verified tokens, MFA | JWKS, issuer and audience check; OTP REQUIRED in the derived production realm | `packages/auth-sdk/README.md` "Tokens"; `packages/auth-sdk/test/production-realms.test.ts`; `apps/core/test/auth-live.test.ts` in `live auth + end-to-end (Keycloak, OpenFGA, Playwright)` (not required) | enforced in code | 2 |
| C-6 | Permissions checked server-side on every mutating Admin API route | `requirePermission` with the operation's `x-permission` read from `packages/contracts/openapi/admin-api.yaml`; OpenFGA down → 503 | `apps/core/test/access-matrix.test.ts`; `apps/core/test/admin-api.test.ts`; `apps/core/README.md` "Server entry" steps 7–9; ADR 0002; job `unit tests (with Postgres, RLS)` (required) for the stubbed matrix, the live job for real tokens | enforced in CI | 1, 2 |
| C-7 | Store scope per request | Publishable key → store-scoped client; staff → `storeClientFor` 403 outside scope | `apps/core/test/tenant-http.test.ts`; `apps/core/test/two-brands-one-pool.test.ts`; `apps/core/test/store-api.test.ts` | enforced in CI | 1 |
| C-8 | Service-account allow-list | Read-only clients plus a per-client operation list, code constants, fail closed | `packages/auth-sdk/README.md` (#632, PR #635); `packages/auth-sdk/test/service-client-callers.test.ts`; `apps/core/test/staff-auth-operation.test.ts`; production steps in `infra/keycloak/README.md` | enforced in CI | 2 |
| C-9 | Dev credentials cannot reach production | Dev tokens only with an explicit opt-in and never in production; production realms derived and compared byte for byte | `apps/core/test/guards.test.ts`; `infra/keycloak/derive-production.mjs`; `packages/auth-sdk/test/production-realms.test.ts` | enforced in CI | 1, 2 |
| C-10 | Replay answers only the owning principal | `completeCart` replay → 409 for another customer | `apps/core/src/modules/checkout/README.md` (replay table); `docs/MANAGER-HANDOFF.md` §11 | enforced in code | 1, 13 |
| C-11 | Role changes are audited | Tuple + mirror + audit row | `packages/auth-sdk/README.md` "Roles", "Audit log" | enforced in code | 2 |
| C-12 | Periodic access review (who holds which role) | — | Searched `docs/` and `infra/` for an access-review procedure: none | gap | owner |
| C-13 | Analytics store access | Separate ingest and read-only users; ClickHouse HTTP bound to loopback locally | `infra/ci/check-ch-access.mjs`; CI step "ClickHouse migrations + access users (analytics_ingest, analytics_ro)" in the live job; `infra/docker/docker-compose.yml` | enforced in code | 12, 5 |

## 2. Change management (CC8)

| # | Control | How it is enforced | Evidence | Status | Owner |
|---|---|---|---|---|---|
| C-14 | Branch protection with required checks | A PR is required, six checks must pass, force-pushes to `main` blocked | Branch-protection API (2026-11-10); `infra/README.md` "Branch protection" | enforced in CI | owner |
| C-15 | Review before merge | Rule: nobody merges their own PR; the Reviewer session decides | `docs/ownership.md` rule 3; CLAUDE.md "Git"; `docs/start-messages/00-reviewer.md`. GitHub does **not** enforce it: `required_pull_request_reviews` is null, `enforce_admins` false, and one account holds every role | documented only | main, owner |
| C-16 | Merge queue | Merges `main` into the branch, regenerates the lockfile only on a lockfile-only conflict, `--frozen-lockfile`, waits for CI, refuses on red, merge commit | `scripts/merge-queue.sh` | documented only (a script a person runs) | main |
| C-17 | Ownership of paths | A branch may write only its prefix's paths | `scripts/check-ownership.sh`, `scripts/check-ownership.test.sh`; job `ownership check` (required) | enforced in CI | main |
| C-18 | Lint, format, types, generated files current | — | job `lint + typecheck` (required), step "generated files are current (events + contracts)" | enforced in CI | 5 |
| C-19 | API contracts hold | Consumers tested against the OpenAPI mocks | job `contract tests (Prism)` (required) | enforced in CI | main |
| C-20 | Live proofs (real tokens, OpenFGA, money gate, PII sweep, leak property) | Run on every PR; each block is checked to have really run | `infra/ci/require-live-tests.mjs`; job `live auth + end-to-end (Keycloak, OpenFGA, Playwright)`. **Not required** (plan D6: after 10 green main runs) | gap (advisory) | 5, owner |
| C-21 | Outbox in the same transaction; never publish directly | `withEvents` is the only writer; lint rule and structural guard | `apps/core/src/outbox/with-events.ts`; `apps/core/src/outbox/outbox.test.ts`; `apps/core/eslint.config.mjs`; `apps/core/test/guards.test.ts`; ADR 0003 | enforced in CI | 14, 1 |
| C-22 | Module boundaries | A module is imported only through its `index.ts` | `apps/core/test/guards.test.ts` (ADR 0005 case) | enforced in CI | 1 |
| C-23 | Migrations are append-only and tested on a managed-Postgres role | New file per change; every migration run as a non-superuser owner | `packages/db/README.md` "Migrations on managed Postgres"; `packages/db/test/managed-postgres-migrations.test.ts`; step "migrate + seed against a fresh database (smoke)" | enforced in CI | main |
| C-24 | Infrastructure as code is validated | Terraform fmt + validate; Helm lint, render, kubeconform, values rules | jobs `terraform fmt + validate`, `helm lint + template + kubeconform`; `infra/terraform/check.sh`, `infra/helm/check.sh`, `infra/helm/check-values.sh` | enforced in CI (advisory jobs) | 5 |
| C-25 | CI runs with least privilege | `permissions: contents: read`; deploy uses AWS OIDC, no long-lived keys | `.github/workflows/ci.yml`; `.github/workflows/deploy-staging.yml`; `infra/terraform/modules/ci-oidc/main.tf` | enforced in code | 5 |
| C-26 | Decisions are recorded | ADRs, plan decisions, CHANGELOG per package | `docs/adr/`, `docs/decisions.md`, `docs/plan/phase6-plan.md` | documented only | main |

## 3. System operations and monitoring (CC7)

| # | Control | How it is enforced | Evidence | Status | Owner |
|---|---|---|---|---|---|
| C-27 | SLOs with burn-rate alert rules | Rules generated from code; hand edits, `promtool check rules` and `promtool test rules` fail the job | `infra/observability/SLO.md`; `infra/observability/rules/slo.mjs`, `infra/observability/rules/slo.rules.yml`, `infra/observability/rules/slo.test.yml`; `infra/observability/check.sh`; job `observability config` | enforced in CI (advisory job) | 5 |
| C-28 | A dead relay is detected | `SLOAbsent_outbox_relay_lag`; `app.outbox_lag()` works on managed Postgres | `infra/observability/rules/slo.rules.yml`; `packages/db/migrations/0208_outbox_lag_owner_role.sql` (#737, PR #761) | enforced in CI (the rule), see C-29 | 5, 14 |
| C-29 | Alerts reach a person | — | `infra/observability/SLO.md`: "No Alertmanager receiver is configured yet" | gap | 5, owner |
| C-30 | Telemetry from the core | Traces and RED metrics per route and store | #729; `infra/observability/otel-collector.yaml`; `infra/observability/grafana/` | enforced in code | 1, 5 |
| C-31 | Rate limits on public write paths | Redis token bucket per class, store and client; 429 + `Retry-After` | `apps/core/src/http/rate-limit.ts` (#742); `apps/core/src/http/rate-limit.test.ts`; `apps/core/src/http/rate-limit.redis.test.ts`; `apps/core/test/rate-limit-http.test.ts`. Limits: fail-open, writes only, no committed k6 burst (`infra/load/k6/`) | enforced in code | 1 |
| C-32 | Security headers and CSP, admin | Per-request nonce CSP; HSTS, `nosniff`, Referrer-Policy, Permissions-Policy | `apps/admin/src/lib/security/csp.ts` (#763); `apps/admin/src/lib/security/static-headers.mjs`; `apps/admin/src/middleware.ts`; `apps/admin/next.config.mjs`; `apps/admin/test/security-headers.test.ts`; `apps/admin/e2e/csp.spec.ts` | enforced in CI | 4 |
| C-33 | Security headers and CSP, storefronts | Per-request CSP with a host allow-list; `X-Frame-Options`, `nosniff`, Referrer-Policy | `apps/storefront-starter/src/lib/csp.ts`; `apps/storefront-starter/test/csp.test.ts`; `apps/storefront-starter/next.config.mjs`; brand copies under `apps/storefronts/`. `script-src` keeps `'unsafe-inline'` | enforced in CI, with a stated weakness | 3, 10 |
| C-34 | Webhook authentication | HMAC over the raw body, constant time, 300 s tolerance, exactly-once | `apps/core/src/modules/payments/webhook-signature.ts`; `apps/core/src/modules/payments/webhooks.test.ts` | enforced in CI | 7 |
| C-35 | Incident response procedure | Deploy rollback and secret rotation runbooks exist | `infra/README.md` "Runbook index". No security-incident procedure (who is told, how access is cut): searched `docs/` and `infra/` | gap | owner, 5 |

## 4. Risk and vendor management (CC3, CC9)

| # | Control | How it is enforced | Evidence | Status | Owner |
|---|---|---|---|---|---|
| C-36 | Secret scan over the whole history | gitleaks, default rules plus reasoned allow-lists, no path filter | job `secret scan (gitleaks)` (required); `infra/gitleaks.toml` | enforced in CI | 5 |
| C-37 | Dependency audit gate | `pnpm audit --prod`, fails on high+ outside the allow-list, fails closed when the lookup does not answer | job `dependency audit (production)` (**advisory**); `infra/ci/audit-gate.mjs`; self-test `infra/ci/audit-gate.test.mjs` in job `what changed` | enforced in CI (advisory job) | 5 |
| C-38 | Allow-list entries expire | Each entry has an owner, a reason and `expires`; expired fails, stale is reported | `infra/security/audit-allowlist.json`; `infra/README.md` "Production dependencies (#730)" | enforced in CI (advisory job) | 5, owning windows |
| C-39 | Dependency updates are proposed | Weekly grouped PRs; majors separately | `.github/dependabot.yml`; starter-synced packages excluded (#758) | enforced in code | 5, main |
| C-40 | Build inputs are pinned | Lockfile with `--frozen-lockfile`; Terraform lock file | `pnpm-lock.yaml`; `scripts/merge-queue.sh`. Actions and the gitleaks image are pinned by tag, not SHA | gap (partial) | 5 |
| C-41 | Secret management | Secrets Manager → External Secrets → pod env; nothing in git or values | ADR 0006; `infra/README.md` "Secrets"; `infra/kubernetes/external-secrets/cluster-secret-store.yaml`; `infra/helm/platform-app/templates/externalsecret.yaml`. Never run with real secrets | documented only | 5, owner |
| C-42 | Vendor register and agreements (Stripe, Anthropic, hosting, RudderStack, Chatwoot, Odoo, Cloudinary, Sanity) | — | Only the per-item lines on `docs/launch-checklist.md`; no register | gap | owner |
| C-43 | Threat model kept current | The PR that changes a control updates the map | `docs/security/README.md` "How to keep it true" | documented only | main |
| C-44 | Penetration test, external scans | — | plan §4 "Deferred" | gap (owner-only) | owner |

## 5. Availability and disaster recovery (A1)

| # | Control | How it is enforced | Evidence | Status | Owner |
|---|---|---|---|---|---|
| C-46 | Restore drill with measured RTO | Backs up Postgres, ClickHouse, Keycloak, OpenFGA; restores into a fresh stack; checks counts, checksums, a login, an allowed and a denied permission. RTO 74–109 s over three runs on 2026-11-07, two windows | `infra/dr/drill.mjs`; `infra/dr/RUNBOOK.md` "Measured" (#741, PR #753); safety parts self-tested by `infra/dr/drill.test.mjs` in job `what changed` | enforced in code (the drill is manual) | 5 |
| C-47 | Scheduled backups and a stated RPO | — | `infra/dr/RUNBOOK.md`: RPO as measured is idle time; the method's RPO depends on a schedule that does not exist | gap | 5, owner |
| C-48 | Managed-database protections | Encryption at rest, not public, retention, deletion protection, final snapshot in staging | `infra/terraform/modules/postgres/main.tf`; `infra/terraform/envs/staging/`; job `terraform fmt + validate`. Never applied | documented only | 5 |
| C-49 | Capacity is measured | k6 load, pool and ceiling runs with a report | `infra/load/README.md`; `infra/load/reports/2026-10-06.md`; `.github/workflows/load.yml` (manual) | enforced in code (manual) | 5 |
| C-50 | Storefront performance budget | Bundle and Lighthouse budgets fail the check | job `storefront performance budget (bundle + Lighthouse)` (required) | enforced in CI | 3, 10 |
| C-51 | Images run non-root and boot | Smoke after build | job `app images (build only, no push)`; `infra/docker/smoke-images.sh`; `infra/helm/platform-app/values.yaml` | enforced in CI (advisory job) | 5 |

## 6. Confidentiality and privacy (C1, P)

| # | Control | How it is enforced | Evidence | Status | Owner |
|---|---|---|---|---|---|
| C-45 | Logging without PII | Per module: rate-limit keys hash the client address; service-client refusals log ids only; accounting logs ids, counts and classes; the AI audit stores a hash and counts; ClickHouse erasure statements run with `log_queries = 0` | `apps/core/src/http/rate-limit.ts`; `packages/auth-sdk/README.md` (#632); `apps/accounting/src/log.ts`; `packages/ai/src/pg-audit.ts`; `apps/analytics-ingest/README.md` "Erasure". No repository-wide log guard | enforced in code (per module); gap for a global check | every window |
| C-52 | Card data never on our servers | Hosted fields; see `pci-saq-a-scope.md` | `apps/storefront-starter/src/components/card-payment.tsx`; `apps/core/src/modules/payments/stripe-client.ts`; ADR 0004 | enforced in code | 7, 3 |
| C-53 | Erasure in Postgres and Keycloak | Customer row emptied, exports deleted, realm user deleted by a consumer with a claim row | `apps/core/src/modules/customers/gdpr.ts`; `apps/core/src/modules/customers/customers.test.ts`; `apps/core/test/customers-api.test.ts`; `apps/core/src/jobs/customer-erasure.ts`; `packages/db/migrations/0199_customer_erasure_claim.sql` | enforced in CI | 13, 2 |
| C-54 | Erasure in ClickHouse | Scrub at insert and on `customer.erased`; refuses to start without the key | `apps/analytics-ingest/README.md` "Erasure" (#623, PR #631); CI step "analytics ingest live block (Redpanda + ClickHouse) — and it really ran". One replica only | enforced in code | 12 |
| C-55 | Erasure on the bus and in replays | 30-day retention on customer-bearing topics; replays skip or scrub | ADR 0003 amendment; `infra/redpanda/topics.policy.json`; `packages/events/src/erasure.ts`; `packages/events/test/erasure.test.ts`; `apps/core/src/outbox/replay-erasure.test.ts`. Open: #629 | enforced in code, residual open | 14 |
| C-56 | Erasure in the CDP / CRM | Suppression of both profiles (#657, PR #660) | `docs/launch-checklist.md` "Data protection". Not verified on a real workspace | documented only | 16 |
| C-57 | No PII in the analytics store | Sweep of every table and string column; a planted e-mail is found | `apps/analytics-ingest/src/pii-sweep.ts`; `apps/analytics-ingest/README.md` "No PII in ClickHouse" says it runs live in the Integration 5 gate (#612). `.github/workflows/ci.yml` names no sweep step (searched for "pii"), so the CI link rests on that README | enforced in code | 12 |
| C-58 | AI redaction and denylist | Customer fields refused at compile time and run time; e-mail, card, IBAN, address, phone, tracking masked before the call | `packages/ai/src/denylist.ts`; `packages/ai/src/redact.ts`; `packages/ai/test/redact-denylist.test.ts`; `packages/ai/test/denylist.typecheck.ts` (#671). Names are not masked | enforced in CI, residual stated | 14 |
| C-59 | AI budget, rate limit and kill switch | Monthly token budget per store and per organization, per-minute limit, per-run ceiling, `AI_ENABLED` | `packages/ai/src/limiter.ts`; `packages/ai/test/limiter.test.ts`; `packages/ai/test/gateway.test.ts`; `apps/core/src/modules/reporting/ask/gateway.ts` (#606, #610) | enforced in CI | 14 |
| C-60 | AI calls are audited without content | One append-only row per attempt, hash of the redacted input | `packages/ai/src/pg-audit.ts`; `packages/ai/test/pg-audit.test.ts`; `packages/db/migrations/0205_ai_call_audit.sql` | enforced in CI | 14, main |
| C-61 | Consent is a ledger | Append-only `customer_consent`, projection rewritten in the same transaction | `packages/db/migrations/0194_customer_consent.sql`; `packages/db/test/rls.test.ts` | enforced in CI | 13, main |
| C-62 | Data-processing agreements and the privacy notice | — | `docs/launch-checklist.md` "Lawyer review" | gap (owner-only) | owner |
| C-63 | Erasure survives a restore | — | Not addressed in `infra/dr/RUNBOOK.md` (searched for "eras") | gap | 5, main |
| C-64 | Encryption in transit | HSTS on the admin, `upgrade-insecure-requests` on storefronts, Redis transit encryption in Terraform, Keycloak `sslRequired: all` in production realms | `apps/admin/src/lib/security/static-headers.mjs`; `apps/storefront-starter/src/lib/csp.ts`; `infra/terraform/modules/redis/main.tf`; `packages/auth-sdk/test/production-realms.test.ts`. The Ingress template has no `tls` block | documented only until a cluster exists | 5 |

## Summary by status

- **Enforced by a required check:** C-1, C-2, C-3, C-4, C-6, C-7, C-8, C-9, C-14, C-17, C-18, C-19, C-21, C-22,
  C-23, C-36, C-50 and the unit-tested parts of C-32, C-33, C-34, C-53, C-58 – C-61 (they run in
  `unit tests (with Postgres, RLS)`).
- **Enforced only by an advisory job:** C-5 and C-20 (the live job), C-24, C-27, C-28, C-37, C-38, C-51, the live
  parts of C-13, C-54, C-57.
- **Documented only:** C-15, C-16, C-26, C-41, C-43, C-48, C-56, C-64.
- **Gaps:** C-12, C-20 (as a gate), C-29, C-35, C-40, C-42, C-44, C-47, C-62, C-63, and the global half of C-45.
