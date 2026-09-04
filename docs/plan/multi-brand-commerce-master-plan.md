# Multi-brand commerce platform — master plan

Companion files: `architecture.svg` (system structure) and `build_phases.svg` (phases and Claude Code windows).

---

## 1. What we are building, in one paragraph

One control plane ("HQ") that owns many online brands. Underneath it sits **one multi-tenant commerce core** (not one system per store) that holds every store's catalog, orders, customers, stock, and pricing, separated by a `store_id` on every row and enforced by database row-level security. Each brand gets its **own storefront** (own domain, theme, layout, content, landing pages) and its **own admin experience**, but that admin experience is the same application as the HQ dashboard with permissions applied: a store admin sees only the stores they are assigned to and never sees accounting; HQ roles see everything. Storage, shipping, accounting, CRM, BI and role management are HQ services that consume events from the core. New brands are onboarded from the HQ dashboard in days, not months.

Why this shape and not "N separate shops plus a reporting layer": shared warehouses need a single inventory truth; automatic accounting needs a single order truth; cross-brand BI needs a single customer truth. Separate shops make all three of those a permanent reconciliation problem.

---

## 2. Architecture, layer by layer

### 2.1 Edge
**Cloudflare** in front of every domain: DNS, CDN, WAF, DDoS protection, bot management, image resizing, TLS. Each brand domain points here. Rules: no origin is reachable without passing the edge; storefront static assets are cached at the edge; admin is geo/IP-restricted if you want.

### 2.2 Experience layer
- **Storefronts** — one **Next.js (App Router)** app per brand, generated from a shared starter and sharing a UI kit through a **Turborepo** monorepo. Each brand can override theme tokens, page layouts, components, and features. Deployed on **Vercel** (fastest path) or on Kubernetes (if you want everything self-hosted). Storefronts only talk to the API edge; they hold no business logic.
- **Content & landing pages** — a headless CMS with one workspace per brand: **Sanity** (best developer + marketer balance), **Storyblok** (best visual editor for marketing teams), or **Payload** (open-source, self-hosted, TypeScript). For marketer-built landing pages without developers: **Builder.io** (drag-and-drop using your real React components). For high-design campaign micro-sites: **Framer**. Design source of truth: **Figma**, exporting design tokens into the UI kit.
- **Admin application** — one Next.js app (**shadcn/ui**, **Tailwind**, **TanStack Query/Table**, **React Hook Form + Zod**). Two "views" live in it: the Store view (catalog, orders, customers, promotions, content, settings, scoped to allowed stores) and the HQ view (all stores, warehouse, finance, BI, roles, brand onboarding). Which sections render is decided by permission checks, and every API behind them re-checks the same permissions server-side.
- **Client analytics** — **PostHog** SDK plus **RudderStack** (or Segment) event tracking on every storefront and the admin.

### 2.3 Identity and authorization
- **Keycloak** or **Zitadel** (self-hosted) — or **Auth0** if you prefer managed. Two realms: staff (HQ + store admins, with SSO and MFA) and customers (per brand, social login, passwordless).
- **OpenFGA** for permissions. You store relationships, not role names in code:
  - `user:ali → store_admin → store:brandA`
  - `user:ali → store_admin → store:brandB`
  - `user:maryam → finance → organization:hq`
  - The Accounting module requires `finance` on `organization`. A store admin, however many stores they manage, never satisfies that check.
- Suggested roles: **Owner**, **Finance**, **Operations/Warehouse**, **Store Admin** (N stores), **Store Staff** (catalog + orders only), **Support** (read everything customer-facing, issue refunds up to a limit), **Analyst** (BI only, no PII export).
- Every admin action writes to an immutable **audit log** (who, what, which store, before/after).

### 2.4 API edge
**Kong** (or AWS API Gateway): authentication check, rate limiting per store and per key, routing, request logging. Behind it: the Store API (what storefronts call), the Admin API (what the admin app calls), and inbound/outbound webhooks (PSPs, carriers, CMS publish events, ERP sync). Every request carries a `store_id` claim; the core refuses requests without one.

### 2.5 Commerce core — Medusa 2 modular monolith
**Medusa 2** (open-source, Node/TypeScript, modular architecture). We use its built-in modules and add HQ-only modules of our own:

| Module | Responsibility |
|---|---|
| Store & channel registry | Stores, domains, currencies, locales, sales channels (web, app, marketplace, POS), per-store settings |
| Catalog / PIM | Products, variants, attributes, categories, per-store. Optional **Akeneo** PIM if merchandisers need enrichment workflows |
| Pricing & promotions | Price lists per store/channel/customer group, coupons, rules. **Talon.One** later for loyalty programs |
| Cart & checkout | Cart, addresses, shipping options, payment sessions. Card data never touches our servers (hosted fields) |
| Orders / OMS | Order lifecycle, edits, split shipments, cancellations, returns, exchanges |
| Inventory & stock locations | HQ-owned warehouses, per-channel allocation, reservations, backorders |
| Fulfillment | Pick/pack, label generation, tracking, 3PL adapters |
| Customers | Accounts, addresses, consent, segments, GDPR export/delete, cross-brand identity |
| Workflows & jobs | Durable multi-step flows with retries and compensation (e.g. place order → reserve stock → capture payment → emit events) |
| Custom HQ modules | Accounting hooks (outbox), warehouse allocation policy, brand onboarding, RBAC scope resolution |

Tenancy rules: every table has `store_id` (or `organization_id` for shared entities like warehouses); PostgreSQL RLS policies enforce it; the API sets the tenant context per request. Every state change writes an event to an **outbox table** in the same transaction; a relay publishes it to the bus. This is what makes accounting and analytics correct without double-writes.

Alternatives, if the team profile differs: **Saleor** (Python/Django, GraphQL-first, multi-channel, multi-warehouse) for a Python team; **commercetools** if you want a managed enterprise platform and can pay for it, trading ownership for SLAs.

### 2.6 External integrations (adapters inside the core)
| Concern | Tools |
|---|---|
| Payments | **Stripe** and/or **Adyen** globally, plus local PSPs per market; per-store accounts or Stripe Connect / Adyen for Platforms for per-brand settlement |
| Shipping | **EasyPost** or **ShipEngine** for carrier aggregation, rate shopping, labels, tracking webhooks; direct adapters for local carriers |
| Tax | **Avalara** or **Stripe Tax** |
| Search & merchandising | **Algolia** (managed, best merchandising UI) or **Typesense**/**Meilisearch** (self-hosted); one index per brand |
| Media | **Cloudinary** or **imgix** |
| Messaging | **Twilio** (SMS, WhatsApp, voice), **Resend** or **Postmark** (email), **Novu** (open-source notification orchestration) |
| Marketing | **Klaviyo** (e-commerce native) or **Customer.io** |
| Support | **Chatwoot** (open-source) or **Intercom**/**Zendesk** |
| Fraud | **Stripe Radar** / **Signifyd** |

### 2.7 Event bus
**Kafka** (or **Redpanda**, Kafka-compatible and simpler to operate). Topics like `order.placed`, `payment.captured`, `refund.issued`, `shipment.created`, `stock.moved`, `customer.updated`, `product.published`. Schemas live in a **schema registry** and are versioned; events are replayable, so a new consumer (say, a new BI model) can rebuild from history.

### 2.8 HQ services (event consumers, HQ roles only)
- **Automatic accounting** — a ledger service that turns events into double-entry journal entries per store and per legal entity: revenue, COGS, VAT/sales tax payable, PSP fees, shipping cost, refunds, chargebacks. Posts to **Odoo** or **ERPNext** (open-source ERP, multi-company, invoicing, bank reconciliation) or, if your accountants already use one, to **NetSuite**, **Xero** or **QuickBooks** via API. Payout files from PSPs are reconciled against the ledger to the cent.
- **Warehouse management** — **Odoo Inventory** or a dedicated WMS if you run physical warehouses: scanner-based pick/pack, cycle counts, multi-brand slotting. If you use 3PLs, this becomes adapter code instead.
- **Analytics ingest** — streams events into ClickHouse for live dashboards.
- **CRM / customer data** — **RudderStack** as the customer data pipeline; **Twenty** (open-source CRM) or **HubSpot** as the CRM; customer 360 across brands.
- **Notifications** — Novu routes to Twilio, Resend, push, and Slack for operations alerts.
- **Brand onboarding** — one flow that creates the store record, domain, CMS workspace, PSP account, search index, theme repo, default roles.

### 2.9 Data platform and BI
| Piece | Tool | Role |
|---|---|---|
| Operational DB | **PostgreSQL** (managed: RDS, Neon) | System of record, RLS |
| Cache/queues | **Redis** | Sessions, cache, rate limits, job queues |
| Real-time analytics | **ClickHouse** | Seconds-fresh revenue, orders/minute, live stock views |
| Warehouse | **BigQuery** or **Snowflake** | History, cross-brand models |
| Ingestion | **Airbyte** | Ad platforms, PSP fees, carrier invoices, CMS |
| Transform/orchestrate | **dbt** + **Dagster** | One model set per store, one consolidated; tests on every model |
| BI | **Metabase** (fast, row-level permissions) or **Superset**; **Looker**/**Power BI** for enterprise governance | Embedded in the admin; store admins see their store, Finance sees all |
| Product analytics | **PostHog** | Funnels, session replay, feature flags, experiments |
| AI | Algolia/Typesense vector search, **Recombee** or in-house recommendations, **Claude API** | Product copy, support drafting, natural-language questions over BI |

### 2.10 Platform, delivery, observability
**Kubernetes** (EKS/GKE) for core and HQ services; **Terraform** + **Helm** for all infrastructure; **ArgoCD** (GitOps) + **GitHub Actions** with preview environments per PR; **OpenTelemetry** → **Grafana/Prometheus/Loki/Tempo** with SLOs per store; **Sentry**; **Vault** (or cloud secrets manager) for per-store PSP and carrier credentials; **Snyk** for dependency scanning; PCI scope minimized by never handling card numbers; **Playwright** (e2e), **k6** (load), **Vitest** (unit), contract tests between packages.

Principle: **modular monolith first**. Split out only what needs independent scaling — search indexer, accounting consumer, analytics ingest.

---

## 3. Domain model (the shared vocabulary every window must use)

```
Organization (HQ)
├── LegalEntity*            (for accounting; a store belongs to one)
├── Warehouse*              (stock locations, shared across stores)
├── User*  ──OpenFGA──►  roles on Organization or Store
└── Store*
    ├── Domain*, Locale*, Currency*
    ├── SalesChannel*       (web, app, marketplace…)
    ├── Product* ─ Variant* ─ InventoryLevel (per Warehouse)
    ├── PriceList*, Promotion*
    ├── Customer* (identity may be linked across stores)
    ├── Cart → Order → Payment*, Shipment*, Return*
    └── ContentSpace (CMS workspace id)

Events (outbox → Kafka): every Order/Payment/Shipment/Stock/Customer/Product change.
LedgerEntry* ← Accounting service derives these from events, never from UI.
```

---

## 4. Complete tool list (buy / self-host / build)

| Area | Primary choice | Alternative | Buy or host |
|---|---|---|---|
| Edge | Cloudflare | Fastly | Buy |
| Storefront | Next.js + Vercel | Next.js on K8s | Buy/host |
| UI kit & repo | Turborepo, pnpm, shadcn/ui, Tailwind | — | Build |
| CMS | Sanity | Storyblok, Payload | Buy/host |
| Landing pages | Builder.io | Framer | Buy |
| Design | Figma | — | Buy |
| Identity | Keycloak | Zitadel, Auth0 | Host/buy |
| Authorization | OpenFGA | Casbin | Host |
| API gateway | Kong | AWS API Gateway | Host/buy |
| Commerce core | Medusa 2 | Saleor, commercetools | Host |
| PIM (optional) | Akeneo | — | Host/buy |
| Search | Algolia | Typesense, Meilisearch | Buy/host |
| Media | Cloudinary | imgix | Buy |
| Payments | Stripe, Adyen | local PSPs | Buy |
| Tax | Avalara | Stripe Tax | Buy |
| Fraud | Stripe Radar | Signifyd | Buy |
| Shipping | EasyPost | ShipEngine | Buy |
| WMS | Odoo Inventory | dedicated WMS / 3PL APIs | Host/buy |
| Accounting/ERP | Odoo or ERPNext | NetSuite, Xero, QuickBooks | Host/buy |
| Event bus | Redpanda | Kafka (MSK/Confluent) | Host/buy |
| CDP | RudderStack | Segment | Host/buy |
| CRM | Twenty | HubSpot | Host/buy |
| Marketing | Klaviyo | Customer.io | Buy |
| Notifications | Novu, Twilio, Resend | Postmark | Host/buy |
| Support | Chatwoot | Intercom, Zendesk | Host/buy |
| Loyalty (later) | Talon.One | — | Buy |
| DB & cache | PostgreSQL (RDS/Neon), Redis | — | Buy |
| Real-time analytics | ClickHouse | — | Host/buy |
| Warehouse | BigQuery | Snowflake | Buy |
| Pipelines | Airbyte, dbt, Dagster | — | Host |
| BI | Metabase | Superset, Looker | Host/buy |
| Product analytics | PostHog | Amplitude | Host/buy |
| AI | Claude API, Recombee | — | Buy |
| Infra | Kubernetes, Terraform, Helm, ArgoCD, GitHub Actions | — | Host |
| Observability | OpenTelemetry, Grafana stack, Sentry | Datadog | Host/buy |
| Secrets & security | Vault, Snyk | cloud secrets manager | Host/buy |
| Testing | Playwright, k6, Vitest | — | Build |
| Build tooling | Claude Code (multiple windows), GitHub | — | Buy |

---

## 5. Phases

Timeline assumes a core team of 6–10 engineers using Claude Code windows in parallel, plus a product lead, a designer, and a finance/ops owner. Weeks are indicative.

### Phase 0 — Foundations and contracts (weeks 1–3, ONE window)
Deliverables:
1. Monorepo (`Turborepo` + `pnpm`) with the directory layout in section 6.
2. `CLAUDE.md` at repo root + one per package (ownership, rules, how to run tests).
3. Domain model and glossary (section 3) as `docs/domain.md`.
4. Database schema for all core entities with `store_id` and RLS policies, as migrations.
5. Event schemas (JSON Schema or Avro) for the full event list, versioned, in `packages/events`.
6. OpenAPI spec for Store API and Admin API; generated TypeScript types in `packages/contracts`.
7. Module ownership map (which window owns which directories).
8. ADRs: tenancy model, auth model, event/outbox pattern, storefront-per-brand, modular monolith.
9. CI skeleton: lint, typecheck, unit tests, contract tests, preview deploy.
10. Local dev environment (docker-compose: Postgres, Redis, Redpanda, Keycloak, OpenFGA, Medusa).
11. Seed data: 3 fake brands, 200 products each, 2 warehouses, users for each role.

Exit criteria: `pnpm install && pnpm dev` brings the whole stack up locally; contracts are tagged `v0.1` and frozen.

### Phase 1 — Isolated modules in parallel (weeks 4–10, SIX windows)
Each window builds against the frozen contracts and mocks everything outside its boundary.
- W1 Core commerce: Medusa 2 setup, store & channel registry, catalog, tenancy middleware, RLS wired, seed brands load.
- W2 Auth & RBAC: Keycloak realms, OpenFGA model and tuples, scope-resolution middleware, role admin API, audit log.
- W3 Storefront starter: Next.js template, UI kit, theme tokens, PLP/PDP/cart/checkout screens against mocked Store API.
- W4 Admin app shell: layout, navigation, auth hook, data-table and form primitives, HQ-vs-store gating by permission.
- W5 Infra & DevOps: Terraform for dev/staging, K8s, ArgoCD, GitHub Actions pipelines, OTel/Grafana, Sentry, Vault, preview environments.
- W6 CMS & landing: CMS schema per brand, Next.js content routes, Builder.io/Framer embedding pattern, media pipeline.

**Integration 1 (weeks 11–12, ONE window):** wire auth → core → storefront → admin; first real checkout in staging with a test PSP; contracts bumped to `v0.2` where reality disagreed with the spec.

### Phase 2 — Commerce completeness, brand 1 live (weeks 13–22, SIX windows)
- W1 Orders & inventory: full OMS lifecycle, stock locations, reservations, returns, order edits.
- W2 Payments, tax, fraud: Stripe/Adyen adapters, one local PSP, Avalara/Stripe Tax, Radar, webhook handling with idempotency.
- W3 Shipping & fulfillment: EasyPost/ShipEngine, labels, tracking webhooks, 3PL adapter interface, pick/pack screens.
- W4 Search, media, promotions: Algolia index per brand with sync, Cloudinary, price lists, coupons.
- W5 Admin store view: catalog, orders, customers, promotions, content, settings screens.
- W6 Brand 1 storefront: real theme, PDP/PLP polish, checkout UX, SEO, i18n, Playwright e2e suite.

**Integration 2 (weeks 23–24, ONE window):** end-to-end order → payment → ship → refund; k6 load test; go-live of brand 1.

### Phase 3 — Multi-store and HQ (weeks 25–34, SIX windows)
- W1 Multi-store & onboarding: N stores with separate domains and settings; brand onboarding flow (store, domain, CMS space, PSP account, index, theme, roles).
- W2 Shared warehouse / WMS: multi-brand allocation rules, Odoo Inventory or WMS integration, scanner flows.
- W3 HQ admin view: all-store dashboard, role management UI (assign stores to admins), finance section gated by OpenFGA.
- W4 Reporting v1: Postgres reporting views, Metabase with row-level permissions, embedded in admin.
- W5 Brands 2 & 3: clone the starter, themes, content, launch checklists.
- W6 Customer accounts: profiles, consent, GDPR export/delete, cross-brand identity linking.

**Integration 3 (weeks 35–36, ONE window):** a brand is onboarded end-to-end from the UI; shared warehouse serves two brands from one stock pool.

### Phase 4 — Events, accounting, CRM (weeks 37–48, FOUR to FIVE windows, keep it small)
- W1 Event bus: Redpanda, outbox relay in the core, schema registry, replay tooling.
- W2 Accounting service: double-entry ledger, PSP fee matching, payout reconciliation, Odoo/ERP sync.
- W3 CRM / CDP: RudderStack, Twenty or HubSpot, segments, Klaviyo flows.
- W4 Notifications: Novu, Twilio SMS/WhatsApp, Resend, Slack ops alerts.
- W5 Support & returns: Chatwoot, returns portal, refund workflows with limits by role.

**Integration 4 (weeks 49–50, ONE window):** ledger matches PSP payouts to the cent for a full month; ERP sync verified by the finance owner.

### Phase 5 — Data platform and AI (weeks 51–62, FIVE windows)
- W1 Real-time analytics: ClickHouse ingest, live revenue by store.
- W2 Warehouse & models: BigQuery, Airbyte sources, dbt models (per store + consolidated), Dagster.
- W3 BI dashboards: Metabase/Superset embedded, finance vs store views, scheduled reports.
- W4 AI features: vector search, recommendations, Claude for product copy, support drafts, BI Q&A.
- W5 Product analytics: PostHog funnels, experiments, feature flags.

**Integration 5 (weeks 63–64, ONE window):** BI numbers = ledger = PSP; performance and access review across every role.

### Phase 6 — Scale and hardening (ongoing, 1–2 windows)
k6 load and SLOs, security audit, PCI/SOC2, DR drills and backups, splitting hot services (search, accounting, analytics ingest) out of the monolith, cost optimization, onboarding a new brand every few days via the flow.

---

## 6. Building with multiple Claude Code windows

### 6.1 The principle
Parallel windows work only when three things are true: **contracts are frozen before they start**, **each window owns disjoint directories**, and **one window integrates**. The Architect window (Phase 0) produces the contracts; the Integrator window (each Int column) is the only one allowed to touch shared packages after that.

### 6.2 Repository layout and ownership

```
repo/
├── CLAUDE.md                     # global rules (section 6.4) — Architect only
├── docs/                         # domain.md, ADRs, ownership.md — Architect/Integrator only
├── packages/
│   ├── contracts/                # OpenAPI + generated types — READ-ONLY for feature windows
│   ├── events/                   # event schemas — READ-ONLY for feature windows
│   ├── db/                       # migrations, RLS policies — Core window proposes, Architect approves
│   ├── ui/                       # shared UI kit — Storefront window owns
│   ├── auth-sdk/                 # OpenFGA client, scope helpers — Auth window owns
│   └── test-utils/               # fixtures, factories — Architect owns
├── apps/
│   ├── core/                     # Medusa 2 + custom modules — Core window owns
│   │   └── src/modules/{registry,catalog,pricing,checkout,orders,inventory,fulfillment,customers,hq-*}
│   ├── admin/                    # Admin app — Admin window owns
│   ├── storefront-starter/       # template — Storefront window owns
│   ├── storefronts/{brand-a,brand-b,...}/   # one per brand — Brand windows own their own folder
│   ├── accounting/               # ledger service — Accounting window owns (Phase 4)
│   ├── analytics-ingest/         # ClickHouse consumer — Data window owns (Phase 5)
│   └── notifications/           # Novu workers — Notifications window owns (Phase 4)
├── infra/                        # Terraform, Helm, ArgoCD — Infra window owns
├── data/                         # dbt, Dagster, Airbyte configs — Data window owns
└── cms/                          # CMS schemas per brand — CMS window owns
```

### 6.3 Window roles

| Window | Name | Owns (write) | Reads | Never touches |
|---|---|---|---|---|
| A | **Architect** (Phase 0 only) | everything | — | — |
| I | **Integrator** (every Int period) | `packages/*`, `docs/`, root config, cross-app wiring | everything | new features |
| 1 | **Core** | `apps/core/**`, proposes `packages/db` migrations | contracts, events | admin, storefronts |
| 2 | **Auth** | `packages/auth-sdk`, Keycloak/OpenFGA config, `apps/core/src/modules/hq-rbac` | contracts | UI apps |
| 3 | **Storefront** | `apps/storefront-starter`, `packages/ui` | contracts | core, admin |
| 4 | **Admin** | `apps/admin/**` | contracts, auth-sdk | core internals |
| 5 | **Infra** | `infra/**`, CI workflows, observability | all app Dockerfiles | app source |
| 6 | **CMS** | `cms/**`, content routes in storefront-starter (agreed file list) | contracts | core |
| 7 | **Payments/Shipping** (Phase 2) | `apps/core/src/modules/{payments,fulfillment,tax,fraud}` | contracts, events | other core modules |
| 8 | **Brand N** (Phases 2–3) | `apps/storefronts/brand-n/**`, `cms/brand-n` | ui, contracts | starter, other brands |
| 9 | **Accounting** (Phase 4) | `apps/accounting/**` | events | core |
| 10 | **Data** (Phase 5) | `data/**`, `apps/analytics-ingest/**` | events, db schema | core, admin |

If two windows both need to change the same file, that file was misassigned: the Integrator reassigns it or moves the shared part into a package.

### 6.4 Root `CLAUDE.md` (put this in every clone)

```
# Project rules — read before every task

## You are window: <NAME>. You own: <paths>. You may read everything. You may write ONLY your owned paths.
## Contracts (packages/contracts, packages/events, packages/db) are frozen. If you need a change, create an
   issue titled "CONTRACT CHANGE: <what>" with the exact diff you need, then keep building against a local
   mock. Do not edit contracts.
## Work on branch <window>/<feature>. Commit small. Open a PR when green. Never merge your own PR.
## Every module exposes: index.ts (public API), README.md (how to use, how to test), and tests. No cross-module
   imports except through public APIs and packages/*.
## Every row you create has store_id (or organization_id). Every query goes through the tenant-scoped client.
   Never bypass RLS.
## Every state change in core writes to the outbox table in the same transaction. Never publish directly.
## Secrets come from env/Vault. Never commit keys. Never log PII.
## Before finishing a task: run `pnpm lint && pnpm typecheck && pnpm test --filter <your-package>`.
   Update your package README. Add a line to CHANGELOG.md under your package.
## Do not refactor code you do not own, even if it looks wrong. File an issue.
```

Each package also gets a short `CLAUDE.md` with: what the package is, how to run it, its public API, its test command, and known constraints.

### 6.5 How a parallel phase runs, week by week
1. **Day 1:** Integrator tags contracts (`contracts@vX`), creates one branch per window, writes each window's task list as GitHub issues with acceptance criteria, and pastes the window-specific `CLAUDE.md` header into each clone.
2. **Daily:** each window works only its issues; when it hits a contract gap it files `CONTRACT CHANGE` and continues with a local mock. Windows never pull each other's branches.
3. **Twice a week:** a human (or the Integrator window in review mode) reviews open PRs and merges to `main`. Contract-change issues are batched.
4. **Last week of the phase:** feature freeze; every window finishes tests and READMEs; no new work.
5. **Integration period:** only the Integrator window is active. It applies batched contract changes, bumps the version, replaces mocks with real wiring, runs the e2e suite, fixes what breaks, and writes an integration report (what changed in contracts, what surprised us, what the next phase must fix).
6. **Next phase Day 1:** repeat from step 1 with the new contract tag.

### 6.6 What must stay single-window
- Phase 0 entirely.
- Every Integration period.
- Database migrations that touch more than one module.
- Event schema changes (Phase 4 especially: the event bus and outbox relay are built by one window, and consumers only start after the schemas are tagged).
- Anything in `packages/*`.
- Production deploys and rollbacks.

### 6.7 Definition of done for any window's task
Tests pass; typecheck passes; no writes outside owned paths (a CI check enforces this via CODEOWNERS); README updated; the feature works against mocks in isolation; PR description says which contract version it was built against.

---

## 7. Team, risks, and decisions still needed from you

**Team shape** for the plan above: 6–10 engineers (one senior per parallel window), a product lead, a designer, a finance/ops owner who validates accounting and warehouse flows, and a QA/automation engineer from Phase 2. Each engineer drives one or two Claude Code windows.

**Biggest risks**
1. Starting parallel work before contracts are frozen — every later phase pays for it. Phase 0 is short but must not be skipped.
2. Building accounting from UI actions instead of events — it will never reconcile. Outbox + ledger from events, from day one of Phase 4.
3. Hiding permissions only in the UI — always enforce at the API and database.
4. Over-splitting into microservices early — stay a modular monolith until a module measurably needs its own scaling.
5. Custom-building cart/checkout/OMS — use Medusa's and extend.

**Decisions I need from you to make this a concrete stack**
- Team's main language (TypeScript → Medusa; Python → Saleor).
- Markets and currencies (chooses local PSPs, tax provider, carriers).
- Own warehouses vs 3PLs (chooses WMS vs adapters).
- Accounting system your accountants use today (chooses ERP target).
- Managed-everything budget (Vercel, Algolia, Cloudinary, Confluent) vs self-hosted-everything on Kubernetes.
- Whether "hegsfield" in your message refers to a specific product you want included.
