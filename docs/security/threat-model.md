# Threat model

Scope: the platform as it is on `main` (2026-11-10), run on the compose stack and in CI. Production infrastructure
exists as Terraform and Helm that validate but have never been applied (plan D1, D7), so every "production" statement
below is about configuration in git, not a running system.

Method: one section per trust boundary. Each has the data flow in words, then a STRIDE table (S spoofing,
T tampering, R repudiation, I information disclosure, D denial of service, E elevation of privilege). Every
mitigation names its evidence. "Issue" is the open issue for the residual risk, or `gap: no issue`.

## 1. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Tenant data (orders, customers, stock, prices) of each store | Postgres, every row with `organization_id` and `store_id` (ADR 0001) | One brand reading or writing another's rows is the worst failure of a multi-brand platform. |
| Customer personal data | Postgres `customer*` tables, Keycloak customers realm, CDP / CRM destinations | GDPR: export, erasure, minimisation. |
| Money state | `payment`, `refund`, the accounting ledger (`ledger_entry`), Odoo | Double charges, wrong books. |
| Card data | Stripe only. Never on our servers (ADR 0004). | PCI scope; see `pci-saq-a-scope.md`. |
| Credentials | Keycloak client secrets, per-store Stripe keys, the Anthropic key, database passwords, `ANALYTICS_ERASURE_KEY` | ADR 0006: Secrets Manager → External Secrets; `.env` locally. |
| Authorization state | OpenFGA tuples, `role_assignment`, `staff_user` | Decides every Admin API permission. |
| The event stream | `outbox` table, Redpanda topics | The source for accounting, analytics, notifications, CDP. |
| Analytics store | ClickHouse (`raw_events`, marts) | Pseudonymous keys; no row-level security of its own. |
| The repository and CI | GitHub, Actions, the operator's laptop | Whoever can merge can ship code to every store. |

## 2. Actors

| Actor | Trust | Entry point |
|---|---|---|
| Anonymous shopper | none | Storefront pages; Store API with the store's publishable key |
| Signed-in customer | their own rows in one store | Storefront; customer token from the customers realm |
| Store staff | the stores OpenFGA says they view or administer | Admin app; staff-realm token |
| HQ staff (owner, finance, analyst, support) | organization scope, by relation | Admin app |
| Service account (`crm-sync`, `analytics-sync`, `core-admin`) | a fixed operation list | `client_credentials` token |
| Other tenant (a store admin of brand A looking at brand B) | hostile for this model | Admin API |
| Third parties: Stripe, Anthropic, Odoo, RudderStack, Chatwoot, Cloudinary, Sanity | their own contract | Outbound calls; inbound webhooks |
| Dependency author / compromised package | none | `pnpm install`, Actions, base images |
| The operator (one person, plus Claude sessions as "windows") | full | Laptop, GitHub admin |

## 3. Boundaries, data flows and threats

### B1. Browser ↔ storefront (Next.js, one per brand)

Flow: the browser loads server-rendered pages. The Store API is called server-side with the store's publishable
key; the browser talks only to its own origin, and on the checkout review step to Stripe (`js.stripe.com`,
`api.stripe.com`, Stripe iframes). Sign-in redirects to the Keycloak customers realm. The policy is built per
request in `apps/storefront-starter/src/middleware.ts` from `apps/storefront-starter/src/lib/csp.ts` (brand copies
under `apps/storefronts/brand-{a,b,c}/src/lib/csp.ts`).

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B1-1 | T/I | XSS runs script in the shop origin | CSP host allow-list, `object-src 'none'`, `base-uri 'self'`; `apps/storefront-starter/test/csp.test.ts` pins every directive | `script-src` has `'unsafe-inline'`: the CSP does not stop injected inline script. React escaping is the real defence. | gap: no issue |
| B1-2 | T | Clickjacking the checkout | `frame-ancestors 'none'` (same file) and `X-Frame-Options: DENY` in `apps/storefront-starter/next.config.mjs` | none known | — |
| B1-3 | T | A campaign embed points at an unreviewed host | `frame-src` allow-list from window 6's list, sandbox per iframe (`csp.ts` comment, REQUEST #199) | An allowed host can serve anything inside its frame. | gap: no issue |
| B1-4 | I | A secret Stripe key is sent to the browser by misconfiguration | Only a value with the publishable-key prefix is handed over: `apps/storefront-starter/src/lib/payment-options.ts` | none known | — |
| B1-5 | T | Brand copies drift from the starter (a fix never reaches a brand) | `sync --check` reports preserved files (docs/MANAGER-HANDOFF.md §11); each brand has its own `test/csp.test.ts` | `next.config.mjs` is a preserved file per brand: header changes need a manual re-sync. | #758 (dependency path only) |

### B2. Browser ↔ admin (Next.js)

Flow: staff sign in through the Keycloak staff realm (TOTP). The admin calls the Admin API, BI and AI endpoints
server-side; tokens never reach the browser, so `connect-src` is `'self'`.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B2-1 | T/E | XSS in the admin acts with a staff session | Nonce-based CSP with `'strict-dynamic'`, no `'unsafe-inline'` for scripts: `apps/admin/src/lib/security/csp.ts` (#763); `apps/admin/test/security-headers.test.ts`, `apps/admin/e2e/csp.spec.ts` | `style-src 'unsafe-inline'` (stated in the file). The e2e spec runs in an advisory job. | — |
| B2-2 | T | Clickjacking a refund button | `frame-ancestors 'none'`, `frame-src 'none'` (same file) | none known | — |
| B2-3 | I | Downgrade, MIME sniffing, referrer leak | HSTS (production build only), `nosniff`, `Referrer-Policy`, `Permissions-Policy`: `apps/admin/src/lib/security/static-headers.mjs`, wired in `apps/admin/next.config.mjs` | HSTS without `preload` (deliberate). | — |
| B2-4 | E | UI shows an action the role may not take | UI gating is convenience only (CLAUDE.md); the server decides (B3). `apps/admin/test/role-access.test.ts` | none beyond B3 | — |

### B3. Storefront / admin ↔ core APIs

Flow: Store API requests carry `X-Publishable-Key`; `storeContextMiddleware` hashes it, looks up `store_api_key`
and builds a store-scoped client. Admin API requests carry a staff JWT; `staffAuthMiddleware` verifies it (JWKS,
issuer, `aud: core-api`), resolves the OpenFGA scope, and each handler runs `requirePermission` with the
operation's `x-permission` from `packages/contracts/openapi/admin-api.yaml`. Chain: `apps/core/README.md` "Server entry".

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B3-1 | S | Forged or foreign staff token | JWKS + issuer + audience check in `packages/auth-sdk`; live suite `apps/core/test/auth-live.test.ts` in the job `live auth + end-to-end (Keycloak, OpenFGA, Playwright)` | That job is not a required check. | #731 (D6) |
| B3-2 | S | Dev token accepted outside dev | `dev:` tokens only with `CORE_DEV_TOKENS=1` and never in production (`apps/core/README.md` step 7); `apps/core/test/guards.test.ts` pins the customer-verifier seam as code-only | A wrongly set environment variable in a non-production environment. | gap: no issue |
| B3-3 | E | A mutating route without a permission check | `x-permission` per operation; `apps/core/test/access-matrix.test.ts` reads it from `admin-api.yaml` and walks roles × operations; `apps/core/test/admin-api.test.ts` | Routes Medusa mounts itself fall outside our chain; unknown `/admin` paths answer 404/401 before Medusa (#265). | — |
| B3-4 | E | **Cross-store read or write** through the API (brand A admin names a brand B id) | `storeClientFor(principal, storeId)` → 403 outside scope, then RLS (B4); `apps/core/test/tenant-http.test.ts`, `apps/core/test/two-brands-one-pool.test.ts` | none known | — |
| B3-5 | I | **Cross-principal replay**: an idempotent `completeCart` replay returns one customer's order to another caller | A replay is answered only to the order's own principal, otherwise 409 with nothing of the order: `apps/core/src/modules/checkout/README.md` (replay table); the rule "a ruling about reads names the principal" in `docs/MANAGER-HANDOFF.md` | Other idempotent endpoints added later must repeat the rule; no generic guard. | gap: no issue |
| B3-6 | D | Credential stuffing, cart and checkout floods | Redis token bucket per (class, store, client), 429 + `Retry-After`: `apps/core/src/http/rate-limit.ts` (#742); `apps/core/src/http/rate-limit.test.ts`, `apps/core/src/http/rate-limit.redis.test.ts`, `apps/core/test/rate-limit-http.test.ts` | Fails open when Redis is down; one bucket per NAT or IPv6 /64; no limit on Store API reads or on the Admin API; no committed k6 burst. | gap: no issue |
| B3-7 | D | OpenFGA down | Fails closed with 503 (`apps/core/README.md` step 7) | Admin unavailable while OpenFGA is down (accepted). | — |
| B3-8 | R | A staff action cannot be attributed | `audit_log` is append-only for the app role (`packages/db/CLAUDE.md`); `X-Request-Id` lands in `audit_log.request_id` | Audit rows are in the same database the operator controls. | gap: no issue |
| B3-9 | I | The core answers without security headers | Not applicable to JSON for most headers; only the export download sets `nosniff` (`apps/core/src/modules/customers/http.ts`) | No HSTS at the core; TLS termination is the ingress's job (B11). | gap: no issue |

### B4. Core ↔ Postgres (row-level security)

Flow: every application process connects as `platform_app` (`NOBYPASSRLS`) and opens a transaction through
`createTenantClient` / `createOrganizationClient`, which set `app.*` transaction-locally. RLS is enabled and
forced on every tenant table. Migrations run as the owner role. `packages/db/README.md`, ADR 0001.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B4-1 | I/T | **Cross-store read, filter, insert or move** at the SQL level | Policies on `organization_id` / `store_id`; `packages/db/test/rls.test.ts` proves it as `platform_app`, in the required job `unit tests (with Postgres, RLS)` | A new table without a policy. Mitigated by B4-3. | — |
| B4-2 | I | Context leaks between pooled connections | `set_config(..., true)` is transaction-local (`packages/db/src/client.ts`); a context-less connection sees nothing (`rls.test.ts`) | none known | — |
| B4-3 | E | **RLS bypass by an unforced table** (owner reads everything) | The migration runner refuses to commit a migration that leaves a table with RLS enabled but not forced: `packages/db/src/migrate.ts`; `packages/db/test/managed-postgres-migrations.test.ts` | A table created with RLS not enabled at all is not caught by that rule; review and `rls.test.ts` coverage are the defence. | gap: no issue |
| B4-4 | E | **RLS bypass by a `BYPASSRLS` or superuser role** | The managed migration role is neither (same test asserts `rolsuper` and `rolbypassrls` false); `infra/kubernetes/bootstrap-db/bootstrap.sql` refuses such an app user; #497 closed | Locally and in CI the migration role is the docker superuser. | — |
| B4-5 | E | **RLS bypass by `SECURITY DEFINER`** | Reporting views are `security_invoker` (`apps/core/src/modules/reporting/reporting-views.test.ts` checks `prosecdef` dependencies); `app.outbox_lag()` is owned by `platform_outbox_lag` (NOLOGIN, NOBYPASSRLS, six columns, unpublished rows only): `packages/db/migrations/0208_outbox_lag_owner_role.sql`, `packages/db/test/metrics.test.ts` | No test enumerates every `SECURITY DEFINER` function and its owner; a new one is caught by review only (definitions today: 0110, 0191, 0196, 0197, 0207, 0208). | gap: no issue |
| B4-6 | T | Raw `pg` use outside the scoped client | `apps/core/test/guards.test.ts` "only src/lib/db.ts imports pg" | Other apps (accounting, engagement) have no such guard. | gap: no issue |
| B4-7 | T/R | History rewritten | No UPDATE/DELETE grants on `audit_log`, `stock_movement`, `ai_call_audit`; `ledger_entry` immutable except three columns (`packages/db/CLAUDE.md`) | The owner role can still change them. | — |

### B5. Core → outbox → bus → consumers

Flow: every state change calls `withEvents` inside its transaction (`apps/core/src/outbox/with-events.ts`). The
relay publishes to Redpanda with key and headers carrying `organization_id` / `store_id`. Consumers (accounting,
analytics ingest, notifications, engagement, the erasure consumer) dedupe on `event_id` and run in organization
scope. ADR 0003.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B5-1 | T | A state change without its event, or an event without its state change | Same transaction, tested: `apps/core/src/outbox/outbox.test.ts`; only `src/outbox` writes the table: lint rule in `apps/core/eslint.config.mjs` and `apps/core/test/guards.test.ts` | none known | — |
| B5-2 | T | A malformed or incompatible event | Schemas validated at write (`with-events.ts`), compatibility in `packages/events/test/schema-compat.test.ts`; generated files checked in `lint + typecheck` ("generated files are current") | none known | — |
| B5-3 | I/T | **Tenant confusion in events**: a consumer applies store A's event to store B, or reads another organization's backlog | The envelope and the message headers carry both ids (`packages/events/src/relay-message.ts`); the relay reads its own organization's backlog (#751, `apps/core/src/outbox/relay.test.ts`); consumers write through organization-scope clients, `consumer_processed` is `organization_only` | Consumers trust the envelope's `store_id`; nothing on the bus authenticates the producer. Anyone who can write to a topic can forge an event. | gap: no issue |
| B5-4 | S/T | A rogue producer or reader on the bus | Topic policy as code: `infra/redpanda/topics.policy.json`. Locally the broker is unauthenticated on all interfaces. | Production ACLs / SASL are Redpanda Cloud settings that do not exist yet. | launch checklist |
| B5-5 | R | Duplicate processing | `event_id` idempotency (`packages/events/test/consumer.test.ts`); Stripe webhooks exactly-once (`apps/core/src/modules/payments/webhooks.test.ts`) | Two concurrent `erp:sync` runs post duplicates to Odoo. | launch checklist (#639 item 4, closed without the lock) |
| B5-6 | D | The relay stops and nobody notices | `SLOAbsent_outbox_relay_lag` and the burn alerts: `infra/observability/rules/slo.rules.yml`, tested by `infra/observability/rules/slo.test.yml` in `observability config` | No receiver is configured: the alert fires to nobody. | gap: no issue |
| B5-7 | I | Erased identifiers stay on the bus | 30-day retention on every topic that can name a customer; replays skip or scrub erased customers: ADR 0003 amendment, `packages/events/src/erasure.ts`, `apps/core/src/outbox/replay-erasure.test.ts` | About 31 days on the bus after erasure; raw `promotion_codes` on a replayed order. | #629 |

### B6. Core ↔ Keycloak / OpenFGA, and service accounts

Flow: Keycloak issues staff and customer tokens (two realms). The core verifies them offline (JWKS) and asks
OpenFGA for relations. Service clients authenticate with `client_credentials`. ADR 0002.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B6-1 | S | Dev realm settings reach production (seeded users, password = username, `test-cli`, a committed TOTP secret, wildcard redirects) | Production realms are derived; `packages/auth-sdk/test/production-realms.test.ts` asserts each row of the dev-only table (`infra/keycloak/README.md`), in `unit tests (with Postgres, RLS)`; the deployable customers realm is checked by `infra/deploy/keycloak/derive-customers-realm.test.mjs` in `helm lint + template + kubeconform` | Never imported into a running cluster. | #342 |
| B6-2 | E | A service account does more than its job | Read-only clients plus a per-client operation allow-list as code constants: `packages/auth-sdk/README.md` (#632); `packages/auth-sdk/test/service-client-callers.test.ts`, `apps/core/test/staff-auth-operation.test.ts` | `crm-sync` holds store `support`, wider than `getCustomer`; the allow-list is the only narrowing. | #625 |
| B6-3 | E | Role changes not applied or not recorded | Tuples + `role_assignment` mirror + audit (`packages/auth-sdk/README.md` "Roles"); scope cache ≤ 30 s, invalidated on change | Up to 30 s of stale scope after a revocation elsewhere. | — |
| B6-4 | S | Password guessing at Keycloak | Brute-force protection in both realms (`infra/keycloak/staff-realm.json`, `infra/keycloak/customers-realm.json`); staff OTP REQUIRED in the production realm | Dev has no password policy (by design). | — |
| B6-5 | T | OpenFGA state lost | Model in git (`infra/openfga/`); restored and checked by the drill (`infra/dr/drill.mjs`) | Compose OpenFGA is in-memory. | launch checklist |

### B7. Core / ingest ↔ ClickHouse

Flow: the analytics ingest consumes the bus and writes `raw_events`; dbt builds marts; the core's metrics API reads
them. ClickHouse has no row-level security: tenant scope is applied by the metrics layer in the app.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B7-1 | I | **Tenant confusion in analytics**: a store's query returns another store's rows | A 300-query leak property and two-store exactness (`apps/core/src/modules/reporting/README.md`); CI step "metrics API on ClickHouse (leak property + p95) — and it really ran" in `live auth + end-to-end (Keycloak, OpenFGA, Playwright)` | Anyone with a ClickHouse login sees every tenant. The job is not required. | #731 (D6) |
| B7-2 | E | The app reads with a writer or admin user | Separate `analytics_ingest` and `analytics_ro` users checked by `infra/ci/check-ch-access.mjs` (#648, closed) | Users as SQL migrations and network isolation in production are not done. | launch checklist |
| B7-3 | I | PII in the analytics store | `apps/analytics-ingest/src/pii-sweep.ts` over every table and string column; `apps/analytics-ingest/README.md` "No PII in ClickHouse" says it runs live in the Integration 5 gate (no step in `ci.yml` names it) | Patterns, not proof: free text in a new payload field. | — |
| B7-4 | I | An erased customer's identifiers stay | Scrub at insert and on `customer.erased`, digests under `ANALYTICS_ERASURE_KEY`, no identifier in SQL text or URLs (`apps/analytics-ingest/README.md` "Erasure", #623) | One replica only; a second replica would write erased rows back. | launch checklist |
| B7-5 | I | The HTTP port is reachable from the LAN | Bound to 127.0.0.1 in `infra/docker/docker-compose.yml` | — | — |

### B8. → Odoo (accounting)

Flow: `apps/accounting` consumes money events, keeps a ledger in Postgres (organization-only RLS) and posts
moves to Odoo through `apps/accounting/src/erp`. Odoo holds no customer identity from us beyond what a move needs.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B8-1 | T | Books differ from orders | The month replay gate (CI step "accounting month replay gate (Integration 4) — and it really ran") and the money identities (#602) | In the non-required live job. | #731 (D6) |
| B8-2 | I | The Odoo key leaks through logs | `apps/accounting/src/log.ts`: ids, counts, amounts and error classes only | No real Odoo instance yet; the key path is untested in production. | launch checklist |
| B8-3 | T | Duplicate moves | One runner at a time (documented) | No lock. | launch checklist |

### B9. → Stripe

Flow: the core creates a manual-capture PaymentIntent with ids and amounts and returns its client secret to the
storefront; the browser confirms inside Stripe's iframes; Stripe calls `POST /webhooks/stripe/:storeCode`.
Detail in `pci-saq-a-scope.md`.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B9-1 | S | A forged or replayed webhook | HMAC over the raw body, constant-time, 300 s tolerance: `apps/core/src/modules/payments/webhook-signature.ts`; `apps/core/src/modules/payments/webhooks.test.ts` | none known | — |
| B9-2 | I | Card data reaches our servers | Hosted fields only; the server client sends ids and amounts (`apps/core/src/modules/payments/stripe-client.ts`, `apps/core/src/lib/payment-seam.ts`) | A future form field or log line. No automated guard against a card field in our own forms. | gap: no issue |
| B9-3 | T | The payment page's scripts are altered (skimming) | CSP limits script hosts to self and Stripe | `'unsafe-inline'` (B1-1); no script inventory or change detection. | gap: no issue |
| B9-4 | T | Store A's key used for store B | Per-store credentials by store code: `apps/core/src/modules/payments/credentials.ts` | Never run on real keys. | #358, #361 |

### B10. → Anthropic (AI features)

Flow: BI Q&A (#606), support reply drafts (#610) and copy drafts call `packages/ai`'s gateway: kill switch →
denylist → escape and redact → budget and per-minute limit → call → audit row (hash and counts, never content).

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B10-1 | T | **Prompt injection through customer text** (a support question, a product field) | Untrusted variables are escaped so no value can open or close a tag; templates tell the model the text is never obeyed (`packages/ai/README.md` "Order of a call", "Templates"); BI Q&A generates no SQL and calls only the metrics API with the caller's scope (`apps/core/src/modules/reporting/README.md`); drafts are shown to staff, not sent | The model can still be steered into a wrong or misleading draft; a person must read it. Tool results are also model input. | gap: no issue |
| B10-2 | I | **PII sent to the model** | Denylist of customer fields (compile-time and run-time) and `redact()`: `packages/ai/src/denylist.ts`, `packages/ai/src/redact.ts`; `packages/ai/test/redact-denylist.test.ts` | Names, spelled-out e-mail, unlisted address and tracking shapes are not masked. The processor terms are unconfirmed. | launch checklist |
| B10-3 | D | **Spend abuse** | Per-store and per-organization monthly token budget, per-minute limit, per-run ceiling, `AI_ENABLED` kill switch: `packages/ai/src/limiter.ts`; `packages/ai/test/limiter.test.ts`, `packages/ai/test/gateway.test.ts`; errors map to 429 + `Retry-After` (`apps/core/src/modules/reporting/ask/gateway.ts`) | The provider-side spend cap is the owner's account setting. | launch checklist |
| B10-4 | R | Nobody can say what was sent | `ai_call_audit`, append-only, hash of the redacted input: `packages/ai/src/pg-audit.ts`, `packages/db/test/ai-call-audit.test.ts` | Content is not kept (deliberate), so a bad answer cannot be replayed. | — |
| B10-5 | I | Another principal reads a conversation | 404 and nothing stored: `apps/core/src/modules/reporting/ask/routes.test.ts` | none known | — |

### B11. Network and deployment

Flow: Helm chart `infra/helm/platform-app` (Deployment, Service, Ingress, ExternalSecret), Terraform modules for
VPC, EKS, RDS, Redis. Nothing has been applied.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B11-1 | I | Data stores reachable from the internet | RDS `publicly_accessible = false`, `storage_encrypted = true` (`infra/terraform/modules/postgres/main.tf`); Redis transit encryption (`infra/terraform/modules/redis/main.tf`) | EKS API `endpoint_public_access = true` (`infra/terraform/modules/cluster/main.tf`). | gap: no issue |
| B11-2 | E | Lateral movement between pods | Non-root, no privilege escalation (`infra/helm/platform-app/values.yaml`); image smoke in `app images (build only, no push)` | No NetworkPolicy; root filesystem is writable. | gap: no issue |
| B11-3 | I | Plain HTTP | The Ingress template has no `tls` block (`infra/helm/platform-app/templates/ingress.yaml`); TLS depends on annotations and the controller | Unproven until a cluster exists. | launch checklist |
| B11-4 | D | Data loss | Drill restores Postgres, ClickHouse, Keycloak, OpenFGA into a fresh stack, RTO 74–109 s at dev scale: `infra/dr/RUNBOOK.md` "Measured" (#741, PR #753) | No scheduled backup; RPO equals the time since the last manual one. | launch checklist |

### B12. CI and supply chain

Flow: every PR runs `.github/workflows/ci.yml` with `permissions: contents: read`. `deploy-staging.yml` uses AWS
OIDC (no long-lived keys) and writes the image tag to `main`.

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B12-1 | T | A known-vulnerable production dependency ships | `dependency audit (production)`: `infra/ci/audit-gate.mjs` against `infra/security/audit-allowlist.json`, fails closed, entries expire; self-tested in `what changed` (`infra/ci/audit-gate.test.mjs`); Dependabot (`.github/dependabot.yml`) | Advisory job; a dated baseline is allowed until 2026-11-20 / 2026-12-06. Starter-synced packages have no bump path. | #758 |
| B12-2 | T | A malicious package or action version | Lockfile, `--frozen-lockfile` in the merge queue (`scripts/merge-queue.sh`) | Actions and the gitleaks image pinned by tag, not SHA; no provenance or SBOM. | gap: no issue |
| B12-3 | I | A secret committed | `secret scan (gitleaks)` over the whole history, required; config `infra/gitleaks.toml` | Allow-listed dev defaults are real credentials on a dev stack (B13-2). | — |
| B12-4 | E | A window edits code it does not own | `ownership check` (required): `scripts/check-ownership.sh`, self-test `scripts/check-ownership.test.sh` | `main/*` and `integration/*` may write anywhere. | — |
| B12-5 | T | Unreviewed code merges | Rule: nobody merges their own PR (`docs/ownership.md` rule 3); the queue refuses red CI | GitHub requires no review and does not bind admins; one account holds every role. | gap: no issue |
| B12-6 | T | A change passes required checks but breaks a live proof | The live job runs on every PR | Not required; the queue can merge before it finishes. | #731 (D6) |

### B13. The operator's laptop and secrets

Flow: one person runs every window on one laptop; `.env` files hold dev values; production secrets do not exist
yet. ADR 0006 defines the production path (Secrets Manager → External Secrets → pod env).

| # | STRIDE | Threat | Mitigation and evidence | Residual risk | Issue |
|---|---|---|---|---|---|
| B13-1 | I | A production secret in git, a values file or a terminal | ADR 0006; `infra/README.md` "Secrets"; `infra/kubernetes/external-secrets/cluster-secret-store.yaml`; gitleaks | Untested until secrets exist. | #361 |
| B13-2 | I/E | The dev stack is reachable from the LAN with well-known credentials | ClickHouse bound to 127.0.0.1 | Postgres, Redis, Redpanda, Keycloak, OpenFGA, Odoo publish on all interfaces (`infra/docker/docker-compose.yml`). Dev data only, but it includes the Anthropic dev key in `.env`. | gap: no issue |
| B13-3 | E | The laptop or the GitHub account is compromised | Force-pushes to `main` blocked (branch protection) | Single point of failure: no second approver, admin bypass allowed. | gap: no issue |
| B13-4 | T | An agent session acts outside its task | CLAUDE.md rules, ownership check, the manager's review | Procedural. | — |

## 4. Erasure and retention, across boundaries

| Store | What happens on erasure | Evidence | Residual |
|---|---|---|---|
| Postgres | The customer row is emptied, orders kept; exports deleted in the same transaction | `apps/core/src/modules/customers/gdpr.ts`, `apps/core/src/modules/customers/customers.test.ts`, `apps/core/test/customers-api.test.ts` | "Orders retained" awaits the lawyer. |
| Keycloak | The customers-realm user is deleted by the erasure consumer | `packages/auth-sdk/README.md` "Customer erasure"; `apps/core/src/jobs/customer-erasure.ts` | Kept while another brand's row uses the subject (owner decision open). |
| Bus | 30-day retention; replays scrub | ADR 0003 amendment | #629 |
| ClickHouse | Scrub and physical delete | `apps/analytics-ingest/README.md` "Erasure" | One replica. |
| CDP / CRM | Suppression per profile (#657, PR #660) | `docs/launch-checklist.md` | Unverified on a real workspace; never-registered guests. |
| Anthropic | Nothing is stored by us; provider retention is contractual | — | Processor terms unconfirmed. |
| Backups | Not addressed | — | gap: no issue (an erased customer returns on restore until the erasure events are replayed). |

## 5. Top residual risks, ranked

1. **The merge gate is weaker than the rules say** (B12-5, B12-6, B3-1, B7-1, B8-1). No enforced review, admin
   bypass, and every live proof in a non-required job. One bad merge reaches every store. Fix: the owner's
   branch-protection change (D6) plus required reviews.
2. **Payment page script integrity is unproven** (B1-1, B9-3) and card payment has never met real keys (#358,
   #361). SAQ-A eligibility depends on it.
3. **Personal data to the model without confirmed processor terms** (B10-2); names are not masked; AI is on by
   default.
4. **Alerts reach nobody and backups are manual** (B5-6, B11-4): an outage or a stuck relay is noticed by a
   person looking.
5. **Erasure windows** (B5-7, B7-4, backups): about 31 days on the bus, single-replica constraint, restore
   re-introduces erased data.
6. **The bus has no producer authentication** (B5-3, B5-4): tenant correctness downstream rests on the envelope.
7. **Supply chain** (B12-1, B12-2): advisory audit, tag-pinned actions, a dated allow-list.
8. **Rate limits fail open and cover writes only** (B3-6).
9. **Network isolation** (B11-1, B11-2, B13-2): public EKS endpoint, no NetworkPolicy, dev stack on all
   interfaces.
10. **`SECURITY DEFINER` and unforced-table drift is caught by review, not by an enumerating test** (B4-3, B4-5).
