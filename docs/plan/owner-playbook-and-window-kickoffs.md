# Your playbook — what you do, what you provide, how to run the windows

Companion to `multi-brand-commerce-master-plan.md`, `architecture.svg`, `build_phases.svg`.

---

## 1. Your parts (the things only you can do)

### 1.1 Decisions to make before Phase 0 starts
1. Language: TypeScript (→ Medusa 2) or Python (→ Saleor). Everything below assumes TypeScript.
2. Markets and currencies for the first three brands.
3. Own warehouses or 3PLs.
4. Which accounting system your accountants use today (Odoo/ERPNext self-hosted, or NetSuite/Xero/QuickBooks).
5. Managed-first (Vercel, Algolia, Cloudinary, Redpanda Cloud, Neon) or self-host-first (all on Kubernetes). Managed-first is faster for Phases 0–3; you can move later.
6. Cloud: AWS or GCP.
7. Legal entities per brand (needed for accounting and PSP accounts).

### 1.2 Accounts you create and own (never let a window create accounts)
Create these with a company email, enable MFA, and hand credentials to the team through a password manager or Vault — never paste keys into a Claude Code window or a chat.

| When | Account | Plan to start with |
|---|---|---|
| Phase 0 | GitHub organization (repo, Actions, CODEOWNERS) | Team |
| Phase 0 | Anthropic — Claude Code seats for each engineer | per developer |
| Phase 0 | Cloud account (AWS or GCP) with billing alerts | pay-as-you-go |
| Phase 0 | Cloudflare (domains, DNS) | Pro, Enterprise later |
| Phase 0 | Figma | Professional |
| Phase 1 | Vercel team (if managed storefronts) | Pro |
| Phase 1 | Sanity or Storyblok workspace | Growth/Team |
| Phase 1 | Sentry, Grafana Cloud (or self-host) | Team |
| Phase 1 | Neon or RDS Postgres, Redis (Upstash/ElastiCache) | starter |
| Phase 2 | Stripe and/or Adyen (test mode first), one local PSP | — |
| Phase 2 | Avalara or Stripe Tax | — |
| Phase 2 | EasyPost or ShipEngine (test keys) | — |
| Phase 2 | Algolia, Cloudinary | Build/Plus |
| Phase 2 | Builder.io (if marketers build landing pages) | Growth |
| Phase 3 | Odoo (self-host) or ERPNext; Metabase (self-host or cloud) | — |
| Phase 4 | Redpanda Cloud (or self-host), Twilio, Resend, Klaviyo, Novu, Chatwoot/Intercom, RudderStack, Twenty/HubSpot | — |
| Phase 5 | BigQuery/Snowflake, Airbyte, Dagster Cloud (or self-host), PostHog, Claude API key | — |
| Phase 6 | Security audit vendor, PCI QSA if needed | — |

### 1.3 Things you hand to the team each phase
- Domains for each brand (registered, DNS on Cloudflare).
- Brand assets: logo, palette, typography, product data sample (CSV), shipping rules, return policy, tax registration numbers.
- Test accounts on every third-party service (test mode only until launch).
- A finance/ops person who validates accounting entries and warehouse flows in Phase 3–4. This cannot be done by engineers.
- Sign-off at every integration gate (see section 4). Nothing merges to `main` during an integration period without your yes.

### 1.4 Things you personally run
- Weekly: read every window's `STATE.md` (section 3). Ten minutes per window tells you where the project is.
- Twice a week: PR review session (with the Integrator window in review mode if you are not an engineer).
- Integration weeks: decide which `CONTRACT CHANGE` issues are accepted.
- Production deploys and rollbacks: you or one named engineer, never an autonomous window.

---

## 2. How to create the windows

### 2.1 One-time setup (you, before Phase 0)
```bash
# 1. Repo
gh repo create <org>/commerce-platform --private --clone
cd commerce-platform
git commit --allow-empty -m "init" && git push -u origin main

# 2. Protect main: require PR, 1 review, CI green, and CODEOWNERS approval (GitHub settings)

# 3. Claude Code on each engineer's machine
npm install -g @anthropic-ai/claude-code
claude          # log in once
```

### 2.2 Phase 0 — the Architect window
Exactly one terminal, on `main`:
```bash
cd commerce-platform && claude
```
Paste the Architect start message (section 5.1). When it finishes, tag: `git tag contracts-v0.1 && git push --tags`.

### 2.3 Every parallel phase — one worktree per window
Never run two windows in the same directory. Each window gets a git worktree (its own folder and branch, same repo):

```bash
cd commerce-platform
git checkout main && git pull

# create one worktree per window (repeat per window)
git worktree add ../wt-core   -b core/phase1   main
git worktree add ../wt-auth   -b auth/phase1   main
git worktree add ../wt-store  -b store/phase1  main
git worktree add ../wt-admin  -b admin/phase1  main
git worktree add ../wt-infra  -b infra/phase1  main
git worktree add ../wt-cms    -b cms/phase1    main

# open a terminal per worktree and start Claude Code inside it
cd ../wt-core && claude       # window 1
cd ../wt-auth && claude       # window 2  (new terminal)
# ...
```
(Claude Code also has a built-in `claude --worktree <name>` that creates the worktree for you; either way works. The rule is one worktree, one branch, one window.)

Then paste that window's start message (section 5). The first thing every start message does is make the window write its own `.claude/CLAUDE.local.md` with its identity, so the rules survive restarts.

### 2.4 Integration periods
Close all feature windows. One terminal on a fresh worktree from `main`:
```bash
git worktree add ../wt-integration -b integration/phase1 main
cd ../wt-integration && claude
```
Paste the Integrator start message (section 5.2). When done and merged: tag `contracts-v0.2`, delete old worktrees (`git worktree remove ../wt-core` etc.), create new ones for the next phase.

### 2.5 Settings that matter
- Keep the default permission mode (Claude asks before running commands) for Phase 0 and every Integration period. For parallel feature windows on their own branches you may allow file edits and test commands without prompting, but never allow `git push --force`, deploys, or anything touching production credentials.
- Add the GitHub MCP server (or the `gh` CLI, already used above) so windows can open PRs and issues themselves.
- CI check on every PR: "files changed are inside this branch's owned paths" (a small script reading `docs/ownership.md`). This is what makes window isolation mechanical rather than a request.

---

## 3. Local memory: surviving the context limit

The context window will fill up several times per phase. The fix is that **the repository is the memory, not the conversation.** Every window keeps a state file that is always current, so a brand-new session can pick up in under a minute.

### 3.1 Files
```
docs/memory/
├── INTEGRATION.md          # Integrator only: contract versions, open CONTRACT CHANGE issues, wiring status
├── core.md                 # one file per window, named after the window
├── auth.md
├── storefront.md
├── admin.md
├── infra.md
├── cms.md
└── ...
```
Each window's memory file has the same fixed sections:

```markdown
# <window> — state
Last updated: <date> · Branch: <branch> · Contracts: <tag> · Last commit: <sha>

## Mission (does not change during the phase)
One paragraph: what this window is building this phase, its owned paths.

## Done
- [x] item — commit sha — one line on what/why

## In progress
- [ ] item — exact next step, file(s) open, what is failing (if anything)

## Next
- [ ] ordered list of remaining tasks from the phase issue list

## Decisions made (with reasons)
- e.g. "Used Medusa's price-list module instead of custom table because …"

## Blocked / waiting
- CONTRACT CHANGE #123 filed, using mock at src/mocks/x.ts until resolved

## Gotchas learned
- things that cost time; the next session must not rediscover them

## How to run & test this package
exact commands
```

### 3.2 The update rule (this line is in every start message)
> After every completed task, and before any commit, update `docs/memory/<window>.md`: move the task to Done with the commit sha, rewrite In progress and Next, add any decision or gotcha. Commit the memory file together with the code. If context is getting long, update the memory file first, then run `/compact`.

Because the memory file is committed with the code, it can never drift from the code, and a new window sees exactly what the previous one saw.

### 3.3 Resume protocol (when a session dies or hits the limit)
Open a new session in the same worktree and paste:

> You are window **<name>**. Read, in this order: `CLAUDE.md`, `.claude/CLAUDE.local.md`, `docs/memory/<window>.md`, then `git log --oneline -20` and `git status`. Summarise in five lines where the previous session stopped. Then continue with the first item under "In progress". Do not redo anything under "Done". Keep updating the memory file after every task.

That is the entire recovery. No history is needed from the old session.

### 3.4 Preventing the limit in the first place
- Work one issue at a time; finish, update memory, commit, then start the next. Short tasks mean short contexts.
- Run `/compact` proactively after each finished task rather than waiting for the warning.
- Put anything a window keeps re-reading (schemas, API shape, how to run tests) into the package `CLAUDE.md`, not into the conversation.
- Long test output: write it to a file and read only the failures.
- Do not paste large logs or documents into the chat; point the window at the file path.

### 3.5 Shared memory across windows
Windows never read each other's memory files during a parallel phase (that reintroduces coupling). The Integrator reads all of them at the start of an integration period, writes `INTEGRATION.md`, and on Day 1 of the next phase resets each window file to a fresh Mission + Next list.

---

## 4. Integration gates (your sign-off checklist)

| Gate | You verify personally |
|---|---|
| Int 1 | Log in as HQ owner and as a store admin; the store admin cannot open Finance. Place one order in staging. |
| Int 2 | Real order on brand 1 with a real card in test mode, refund it, print a shipping label. Load test report shows target orders/minute. |
| Int 3 | Onboard a new brand from the HQ UI without engineering help. Two brands sell from one warehouse stock pool. |
| Int 4 | Your finance person confirms one month of ledger entries match PSP payouts to the cent. |
| Int 5 | BI dashboard revenue = ledger = PSP for the same period. Analyst role cannot export PII. |

---

## 5. Start messages for every window

Paste each message as the first prompt in its terminal. Replace `<...>` placeholders. Every message ends with the same memory rule.

### 5.1 Architect (Phase 0, single window on `main`)
```
You are the ARCHITECT window for a multi-brand commerce platform. Read docs/multi-brand-commerce-master-plan.md fully before doing anything.

Your job in this phase: build the foundations and freeze the contracts so that six parallel windows can start in Phase 1 without talking to each other. You own every path in the repo during this phase.

Stack decisions (fixed): TypeScript everywhere, Turborepo + pnpm monorepo, Medusa 2 as commerce core, PostgreSQL with row-level security on store_id, Keycloak + OpenFGA for identity/authorization, Next.js App Router for storefronts and admin, Redpanda (Kafka API) event bus with an outbox table, Cloud: <AWS|GCP>, managed services: <list>.

Deliver, in this order, committing after each:
1. Monorepo skeleton with the layout in plan section 6.2. Root CLAUDE.md using the template in plan section 6.4. A CLAUDE.md in every package describing purpose, run and test commands, public API.
2. docs/domain.md — the domain model and glossary from plan section 3, expanded with every entity's fields.
3. docs/ownership.md — the window → owned paths table from plan section 6.3, and a script scripts/check-ownership.sh that fails CI if a PR from branch <window>/* changes files outside that window's paths.
4. packages/db — migrations for every core entity with store_id/organization_id, RLS policies, and a tenant-scoped client. Tests that prove a store-A session cannot read store-B rows.
5. packages/events — JSON Schema for every event in plan section 2.7, versioned, with a generated TypeScript type per event and an outbox table migration.
6. packages/contracts — OpenAPI for the Store API and Admin API covering registry, catalog, pricing, cart/checkout, orders, inventory, fulfillment, customers, roles. Generated TS types and a mock server (Prism or MSW) every window can run.
7. ADRs in docs/adr/: tenancy, auth model, outbox/events, storefront-per-brand, modular monolith.
8. CI: lint, typecheck, unit, contract tests, ownership check, preview deploy placeholder.
9. docker-compose for local dev: Postgres, Redis, Redpanda, Keycloak, OpenFGA, Medusa, mock API. `pnpm dev` brings it all up.
10. Seed data: 3 brands, 200 products each, 2 warehouses, one user per role.
11. docs/memory/ with the template from the playbook section 3.1 and one file per Phase 1 window, each containing only its Mission and Next list taken from plan Phase 1.
12. GitHub issues: one per Phase 1 task, labelled by window, with acceptance criteria.

Rules: ask me before choosing any library not named in the plan. Do not build features; build scaffolding, contracts, tests and docs. When done, tell me to tag contracts-v0.1.

Memory rule: keep docs/memory/architect.md current — after every completed step and before every commit, update Done/In progress/Next/Decisions/Gotchas and commit it with the code. If context grows long, update the memory file first, then run /compact.
```

### 5.2 Integrator (every integration period, single window)
```
You are the INTEGRATOR window. Phase <N> is finished; all feature windows are closed. You are the only window active and the only one allowed to edit packages/*, docs/*, and root config.

Read in this order: CLAUDE.md, docs/memory/INTEGRATION.md, every file in docs/memory/*.md, all open GitHub issues labelled CONTRACT CHANGE, and `git log --oneline main -50`.

Then:
1. Write a short integration plan in docs/memory/INTEGRATION.md: which branches merge in which order, which contract changes are accepted (I will confirm), what wiring replaces which mocks.
2. Merge branches into integration/phase<N> one at a time, resolving conflicts, running the full test suite after each.
3. Apply accepted contract changes, bump packages/contracts and packages/events versions, regenerate types, fix every consumer.
4. Replace mocks with real wiring for this phase's goal: <e.g. Int 1: auth → core → storefront → admin, first checkout in staging>.
5. Run and fix the e2e suite until green; run k6 smoke.
6. Write docs/memory/INTEGRATION.md "Phase <N> report": what changed in contracts, what surprised us, what the next phase must fix first.
7. Reset every docs/memory/<window>.md to a fresh Mission + Next list for Phase <N+1> from the plan, and create the Phase <N+1> GitHub issues per window.
8. Open one PR integration/phase<N> → main and stop. I merge it and tag contracts-v0.<N+1>.

Never add features. Never rewrite a window's code beyond what integration needs; file an issue instead.

Memory rule: keep docs/memory/INTEGRATION.md current after every step and commit it with the code. If context grows long, update it first, then run /compact.
```

### 5.3 Phase 1 windows

**Window 1 — Core**
```
You are window CORE. Read CLAUDE.md, docs/ownership.md, docs/domain.md, docs/memory/core.md, and the GitHub issues labelled window:core. Write .claude/CLAUDE.local.md containing: "I am window CORE. I own apps/core/** and may propose migrations in packages/db via PR only. Contracts are frozen at contracts-v0.1."

Mission this phase: stand up Medusa 2 in apps/core with the store & channel registry, catalog module, tenant-scoped data access using packages/db, RLS enforced on every query, outbox writes on every state change, and the seed brands loading. Implement the Store API and Admin API routes for registry and catalog exactly as in packages/contracts; everything else stays on the mock server.

Work one issue at a time on branch core/phase1. Tests for every module. If a contract does not fit, open an issue titled "CONTRACT CHANGE: ..." with the exact diff and continue against a local mock. Open a PR per finished issue; never merge your own PR.

Memory rule: after every completed task and before every commit, update docs/memory/core.md (Done with sha, In progress, Next, Decisions, Gotchas) and commit it with the code. If context grows long, update the memory file first, then run /compact.
```

**Window 2 — Auth**
```
You are window AUTH. Read CLAUDE.md, docs/ownership.md, docs/adr/auth.md, docs/memory/auth.md, issues labelled window:auth. Write .claude/CLAUDE.local.md: "I am window AUTH. I own packages/auth-sdk/**, infra/keycloak/**, infra/openfga/**, apps/core/src/modules/hq-rbac/**. Contracts frozen at contracts-v0.1."

Mission: Keycloak realms (staff with MFA + SSO, customers per brand), the OpenFGA authorization model with relations organization:{owner,finance,operations,analyst} and store:{store_admin,store_staff,support}, tuple management API, a scope-resolution middleware that turns a JWT into the list of store_ids a request may touch and a set of permissions, and an append-only audit log. Ship packages/auth-sdk with `can(user, action, resource)` and `allowedStores(user)`. Prove with tests that a store_admin of two stores gets 403 on any finance route.

Branch auth/phase1, one issue at a time, PR per issue, never merge your own. Contract gaps → "CONTRACT CHANGE:" issue + local mock.

Memory rule: after every completed task and before every commit, update docs/memory/auth.md and commit it with the code. Long context → update memory first, then /compact.
```

**Window 3 — Storefront starter**
```
You are window STOREFRONT. Read CLAUDE.md, docs/ownership.md, docs/memory/storefront.md, issues labelled window:storefront. Write .claude/CLAUDE.local.md: "I am window STOREFRONT. I own apps/storefront-starter/** and packages/ui/**. Contracts frozen at contracts-v0.1."

Mission: a Next.js App Router storefront template and a shared UI kit. Theme tokens from Figma (I will provide the export at <path>), brand override mechanism (tokens, layout slots, component overrides) so a brand can look completely different without forking the starter. Pages: home, category (PLP), product (PDP), search, cart, checkout steps, account, order history, CMS content pages. All data from the mock Store API in packages/contracts. i18n and multi-currency from day one. Lighthouse ≥ 90 on PLP/PDP. Playwright smoke tests.

Branch store/phase1, one issue at a time, PR per issue, never merge your own. Contract gaps → "CONTRACT CHANGE:" issue + mock.

Memory rule: after every completed task and before every commit, update docs/memory/storefront.md and commit it with the code. Long context → update memory first, then /compact.
```

**Window 4 — Admin shell**
```
You are window ADMIN. Read CLAUDE.md, docs/ownership.md, docs/memory/admin.md, issues labelled window:admin. Write .claude/CLAUDE.local.md: "I am window ADMIN. I own apps/admin/**. Contracts frozen at contracts-v0.1. I use packages/auth-sdk for all permission checks."

Mission: the single admin application with two views decided by permissions. Build the shell: layout, navigation that renders only sections the user's permissions allow (HQ sections: Stores, Warehouse, Finance, BI, Roles, Onboarding; Store sections: Catalog, Orders, Customers, Promotions, Content, Settings), a store switcher limited to allowedStores(user), auth hook, data-table and form primitives (TanStack Table, React Hook Form + Zod, shadcn/ui), and working screens for registry and catalog against the mock Admin API. Every screen also handles 403 gracefully because the server re-checks.

Branch admin/phase1, one issue at a time, PR per issue, never merge your own. Contract gaps → "CONTRACT CHANGE:" issue + mock.

Memory rule: after every completed task and before every commit, update docs/memory/admin.md and commit it with the code. Long context → update memory first, then /compact.
```

**Window 5 — Infra & DevOps**
```
You are window INFRA. Read CLAUDE.md, docs/ownership.md, docs/memory/infra.md, issues labelled window:infra. Write .claude/CLAUDE.local.md: "I am window INFRA. I own infra/**, .github/workflows/**, and Dockerfiles. I never edit application source. Cloud: <AWS|GCP>. I never use production credentials; all secrets come from Vault/secrets manager via env."

Mission: Terraform modules for dev and staging (network, Kubernetes cluster, managed Postgres, Redis, Redpanda, object storage), Helm charts and ArgoCD apps for core, admin, and the mock API, GitHub Actions pipelines (lint/typecheck/test/contract/ownership-check, preview environment per PR, deploy to staging on merge to main), OpenTelemetry → Grafana/Prometheus/Loki/Tempo, Sentry, Vault, and a runbook in infra/README.md. Everything reproducible from an empty account with `terraform apply`.

Branch infra/phase1, one issue at a time, PR per issue, never merge your own. Ask me before creating any cloud resource that costs more than <amount>/month.

Memory rule: after every completed task and before every commit, update docs/memory/infra.md and commit it with the code. Long context → update memory first, then /compact.
```

**Window 6 — CMS & landing pages**
```
You are window CMS. Read CLAUDE.md, docs/ownership.md, docs/memory/cms.md, issues labelled window:cms. Write .claude/CLAUDE.local.md: "I am window CMS. I own cms/** and only these files in the storefront starter: apps/storefront-starter/src/app/(content)/** and apps/storefront-starter/src/lib/cms/**. Contracts frozen at contracts-v0.1."

Mission: <Sanity|Storyblok> as headless CMS with one workspace per brand. Define content schemas (page, hero, section blocks, campaign landing page, navigation, footer, legal pages, product-story block linking to a catalog product id), the fetch layer with preview mode and cache revalidation on publish webhooks, content routes in the starter, and an embedding pattern for Builder.io and Framer campaign pages under /campaign/*. Media through Cloudinary. Document in cms/README.md how a marketer builds a landing page without a developer.

Branch cms/phase1, one issue at a time, PR per issue, never merge your own. Contract gaps → "CONTRACT CHANGE:" issue + mock.

Memory rule: after every completed task and before every commit, update docs/memory/cms.md and commit it with the code. Long context → update memory first, then /compact.
```

### 5.4 Later-phase windows (same shape; swap the Mission)

**Phase 2 — Orders & inventory (CORE window continues)**
```
You are window CORE for Phase 2. Read CLAUDE.md, .claude/CLAUDE.local.md, docs/memory/core.md, docs/memory/INTEGRATION.md "Phase 1 report", issues window:core. Contracts are now contracts-v0.2.
Mission: full order lifecycle (place, edit, cancel, split shipment, return, exchange), stock locations with reservations and backorders, all as Medusa modules/workflows with compensation on failure, every transition emitting its event through the outbox. Tests cover every transition.
Same branch rules (core/phase2), same memory rule on docs/memory/core.md.
```

**Phase 2 — Payments, tax, fraud**
```
You are window PAYMENTS. Own apps/core/src/modules/{payments,tax,fraud}/**. Read CLAUDE.md, docs/memory/payments.md, issues window:payments. Contracts-v0.2.
Mission: Stripe and Adyen payment providers (hosted fields only, never handle PAN), one local PSP <name>, Avalara/Stripe Tax adapter, Stripe Radar hooks, idempotent webhook handlers with signature verification and replay protection, per-store credentials read from Vault. Test mode only. Tests replay recorded webhooks.
Branch payments/phase2; same PR and memory rules on docs/memory/payments.md.
```

**Phase 2 — Shipping & fulfillment**
```
You are window SHIPPING. Own apps/core/src/modules/{fulfillment,shipping}/**. Contracts-v0.2.
Mission: EasyPost/ShipEngine provider for rates, labels, tracking webhooks; a 3PL adapter interface with one in-memory implementation; pick/pack state machine; shipment events on the outbox.
Branch shipping/phase2; same PR and memory rules on docs/memory/shipping.md.
```

**Phase 2 — Search, media, promotions**
```
You are window SEARCH. Own apps/core/src/modules/{search,promotions}/** and apps/core/src/jobs/index-*.ts. Contracts-v0.2.
Mission: Algolia index per brand with incremental sync from product.published events, merchandising rules API, Cloudinary media pipeline, price lists and coupon rules with tests for stacking and exclusion.
Branch search/phase2; same PR and memory rules on docs/memory/search.md.
```

**Phase 2 — Admin store view (ADMIN continues)**
```
You are window ADMIN for Phase 2. Read docs/memory/admin.md and the Phase 1 report. Contracts-v0.2.
Mission: complete Store view screens against the real Admin API: catalog editing with variants and media, order detail with fulfil/refund/return actions, customers, promotions, content links, store settings. Every mutating action asks the server, never assumes permission.
Branch admin/phase2; same rules; memory on docs/memory/admin.md.
```

**Phase 2 — Brand 1 storefront**
```
You are window BRAND-A. Own apps/storefronts/brand-a/** and cms/brand-a/**. You read packages/ui and the starter but never edit them; if the starter needs a change, file an issue. Contracts-v0.2.
Mission: brand A's real storefront from the starter: theme and layout from the Figma at <path>, real content in its CMS workspace, checkout UX polish, SEO (metadata, sitemaps, structured data), i18n for <locales>, full Playwright e2e for browse → buy → account.
Branch brand-a/phase2; same PR and memory rules on docs/memory/brand-a.md.
```

**Phase 3 — Multi-store & onboarding (CORE), Warehouse/WMS, HQ admin view (ADMIN), Reporting v1, Brands 2 & 3, Customer accounts** — copy the Phase 2 pattern: name, owned paths, contracts tag, one-paragraph Mission taken from plan section 5 Phase 3, branch `<window>/phase3`, memory file `docs/memory/<window>.md`.

**Phase 4 — Event bus (single window first)**
```
You are window EVENTS. Own apps/core/src/outbox/**, infra/redpanda/**, packages/events/** (exception granted this phase only). No other window starts until you tag events-v1.
Mission: Redpanda cluster config, outbox relay with exactly-once-per-event delivery semantics (idempotency keys), schema registry, replay CLI, consumer SDK in packages/events with a dead-letter pattern. Tests replay 10k historical orders through the relay.
Branch events/phase4; memory on docs/memory/events.md.
```

**Phase 4 — Accounting service**
```
You are window ACCOUNTING. Own apps/accounting/**. Read packages/events (events-v1) and docs/domain.md. You never read core internals; everything comes from events.
Mission: a double-entry ledger service: chart of accounts per legal entity, journal entries derived from order/payment/refund/shipment/stock events (revenue, COGS, tax payable, PSP fees, shipping, chargebacks), PSP payout reconciliation from Stripe/Adyen reports, sync to <Odoo|ERPNext|NetSuite|Xero> via API, and a Finance-only read API. Tests prove that replaying a month of events produces balanced books that match the PSP payout total.
Branch accounting/phase4; memory on docs/memory/accounting.md.
```

**Phase 5 — Data platform**
```
You are window DATA. Own data/** and apps/analytics-ingest/**. Read packages/events and packages/db schema only.
Mission: ClickHouse ingest from the bus for real-time revenue by store; BigQuery warehouse loaded by Airbyte (PSP, ads, carriers) and by CDC from Postgres; dbt models: one set per store, one consolidated, with tests; Dagster orchestration; Metabase dashboards embedded in the admin with row-level filtering by allowedStores(user). Finance dashboard = ledger totals.
Branch data/phase5; memory on docs/memory/data.md.
```

---

## 6. Day-one checklist (print this)

- [ ] Decisions 1–7 in section 1.1 answered and written into `docs/decisions.md`.
- [ ] GitHub org, Claude Code seats, cloud account with billing alerts, Cloudflare, Figma.
- [ ] Repo created, `main` protected, CODEOWNERS enabled.
- [ ] Plan and playbook files committed under `docs/`.
- [ ] One terminal, `claude`, paste the Architect message.
- [ ] When Architect says done: review `docs/memory/architect.md`, run `pnpm dev`, tag `contracts-v0.1`.
- [ ] Create six worktrees, six terminals, paste six Phase 1 messages.
- [ ] Calendar: PR review Tue/Thu, memory-file read Friday, integration weeks blocked.
