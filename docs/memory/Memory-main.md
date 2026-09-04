# Memory main — whole-project state
Owner: main window (Architect in Phase 0, Integrator in every integration period).
Last updated: 2026-09-04 · Current phase: 0 · Contracts tag: (none) · Events tag: (none) · main last commit: see Current status

## What this project is
A multi-brand commerce platform: one HQ control plane, one multi-tenant commerce core (Medusa 2, Postgres RLS on store_id),
N brand storefronts (Next.js), one admin app with permission-driven HQ/Store views, event bus → automatic accounting, CRM, BI.
Full design: docs/plan/multi-brand-commerce-master-plan.md · Diagrams: docs/plan/architecture.svg, docs/plan/build_phases.svg
How to run the project solo on Max 5x: docs/plan/solo-max5x-schedule.md · Owner tasks + kickoff messages: docs/plan/owner-playbook-and-window-kickoffs.md

## Fixed decisions (edit docs/decisions.md, then mirror here)
- Language: TypeScript everywhere · Core: Medusa 2 · Storefront/Admin: Next.js App Router · Auth: Keycloak + OpenFGA
- Cloud: AWS · Managed-first for Phases 0–3 (Vercel, Neon, Upstash, Redpanda Cloud)
- Markets/currencies: A=EU/EUR, B=UK/GBP, C=US/USD · Warehouses: own (wh-eu, wh-us) · Accounting target: Odoo · Legal entities: one per brand
- CMS: Sanity (dataset per brand) · Search: Algolia (index per brand) · PSP: Stripe (Connect), no local PSP before Phase 3
- Solo operator on Claude Max 5x: ONE build window active at a time, Reviewer session for merges, strongest model only for main window + events/accounting

## Current status
- Phase 0 in progress (main window, Architect). Repo: https://github.com/mfx1590/Commerce-Platform (main).
- Done: step 1 monorepo skeleton (99d4661, 8681771) · step 2 docs/domain.md (pending sha)
- In progress: step 3 scripts/check-ownership.sh hardening + CI wiring
- Next: 4 packages/db · 5 packages/events · 6 packages/contracts · 7 ADRs · 8 CI · 9 docker-compose · 10 seeds · 11 issues · 12 tag
- Decisions this phase: plain SQL migrations run by an in-repo runner over node-postgres (no ORM); Prism for the mock server; Vitest; docs/** excluded from prettier (tables are grepped by scripts).
## Phase plan and gates
| Phase | Goal | Windows (in order, one at a time) | Gate (you verify) |
|---|---|---|---|
| 0 | Foundations & contracts | main | `pnpm dev` boots everything; contracts-v0.1 tagged |
| 1 | Isolated modules | 1 core → 2 auth → 3 storefront → 4 admin | store admin cannot open Finance; one order in staging |
| Int 1 | wire it | main | first checkout end to end |
| 2 | Commerce complete, brand 1 live | 1 core → 7 payments → 8 shipping → 9 search → 4 admin → 6 cms → 5 infra → 10 brands(A) → 3 storefront | real test-mode order, refund, label; load test |
| Int 2 | launch brand 1 | main | go-live |
| 3 | Multi-store & HQ | 1 core → 11 warehouse → 4 admin → 2 auth → 12 data → 13 customers → 10 brands(B,C) | onboard a brand from UI; shared stock pool |
| Int 3 | join HQ & stores | main | — |
| 4 | Events, accounting, CRM | 14 events (alone, first) → 15 accounting → 16 engagement | ledger = PSP payouts to the cent |
| Int 4 | reconcile | main | — |
| 5 | Data platform & AI | 12 data | BI = ledger = PSP |
| Int 5 | validate | main | — |
| 6 | Scale & hardening | main | continuous |

## Window index
| # | Key | Title | First phase | Memory file | Model |
|---|---|---|---|---|---|
| 1 | core | Core commerce | 1 | docs/memory/Memory-1-core.md | Sonnet (strongest for migrations) |
| 2 | auth | Auth & RBAC | 1 | docs/memory/Memory-2-auth.md | Sonnet (strongest for the OpenFGA model) |
| 3 | storefront | Storefront starter & UI kit | 1 | docs/memory/Memory-3-storefront.md | Sonnet |
| 4 | admin | Admin application | 1 | docs/memory/Memory-4-admin.md | Sonnet |
| 5 | infra | Infra & DevOps | 2 | docs/memory/Memory-5-infra.md | Sonnet |
| 6 | cms | CMS & landing pages | 2 | docs/memory/Memory-6-cms.md | Sonnet |
| 7 | payments | Payments, tax, fraud | 2 | docs/memory/Memory-7-payments.md | Sonnet (strongest for webhook idempotency design) |
| 8 | shipping | Shipping & fulfillment | 2 | docs/memory/Memory-8-shipping.md | Sonnet |
| 9 | search | Search, media, promotions | 2 | docs/memory/Memory-9-search.md | Sonnet |
| 10 | brands | Brand storefronts (A, B, C…) | 2 | docs/memory/Memory-10-brands.md | Sonnet |
| 11 | warehouse | Shared warehouse / WMS | 3 | docs/memory/Memory-11-warehouse.md | Sonnet |
| 12 | data | Data platform, BI & AI | 3 | docs/memory/Memory-12-data.md | Sonnet |
| 13 | customers | Customer accounts & identity | 3 | docs/memory/Memory-13-customers.md | Sonnet |
| 14 | events | Event bus & outbox relay | 4 | docs/memory/Memory-14-events.md | strongest |
| 15 | accounting | Automatic accounting | 4 | docs/memory/Memory-15-accounting.md | strongest |
| 16 | engagement | CRM, notifications & support | 4 | docs/memory/Memory-16-engagement.md | Sonnet |

Start messages for every window: docs/start-messages/ · Ownership map (CI-enforced): docs/ownership.md

## Contract change log
- (none yet) — format: date · CONTRACT CHANGE #issue · accepted/rejected · new tag

## Integration reports
- (none yet)

## Global gotchas (things every window must know)
- (none yet)

## Usage budget notes (Max 5x)
- Check /usage before big tasks. Past ~60% weekly by Wednesday → docs/tests only until reset.
