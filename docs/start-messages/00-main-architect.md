# Start message — Main window: ARCHITECT (Phase 0)
Open a terminal in the repo root (`main` branch, no worktree). Model: strongest available. Nothing else running.

---

You are the MAIN window acting as ARCHITECT for Phase 0. Read fully, in this order: CLAUDE.md, docs/memory/Memory-main.md, docs/plan/multi-brand-commerce-master-plan.md, docs/plan/solo-max5x-schedule.md, docs/ownership.md, docs/decisions.md. Do not modify docs/plan/* or any docs/memory/Memory-<n>-*.md in this phase; you own Memory-main.md.

Your job: build the foundations and freeze the contracts so that windows 1–4 can run in sequence in Phase 1 without ever talking to each other. Every deliverable is scaffolding, contracts, tests, or docs — no features.

Stack (fixed): TypeScript, Turborepo + pnpm, Medusa 2 core, PostgreSQL with RLS on store_id, Keycloak + OpenFGA, Next.js App Router (storefront + admin), Redpanda with an outbox table, managed-first hosting per docs/decisions.md.

Deliver in this order, committing after each step and updating Memory-main.md "Current status" after each:
1. Monorepo skeleton per plan section 6.2 (apps/, packages/, infra/, data/, cms/). Root package.json, turbo.json, pnpm-workspace.yaml, tsconfig base, eslint/prettier. A CLAUDE.md in every package: purpose, run/test commands, public API.
2. docs/domain.md — expand plan section 3 into every entity with fields, keys, and which window owns it.
3. scripts/check-ownership.sh made real: reads docs/ownership.md, compares `git diff --name-only origin/main...HEAD` with the branch prefix, exits 1 on violation. Wire into CI.
4. packages/db — migrations for every core entity with store_id/organization_id, RLS policies, tenant-scoped client. Tests prove store-A session cannot read store-B rows.
5. packages/events — JSON Schema per event in plan section 2.7, versioned, generated TS types, outbox table migration.
6. packages/contracts — OpenAPI for Store API and Admin API (registry, catalog, pricing, cart/checkout, orders, inventory, fulfillment, customers, roles), generated TS types, and a mock server (Prism or MSW) runnable with `pnpm mock`.
7. ADRs in docs/adr/: tenancy, auth model, outbox/events, storefront-per-brand, modular monolith.
8. CI: lint, typecheck, unit, contract tests, ownership check, preview placeholder.
9. docker-compose: Postgres, Redis, Redpanda, Keycloak, OpenFGA, mock API. `pnpm dev` boots everything.
10. Seed data: 3 brands × 200 products, 2 warehouses, one user per role.
11. GitHub issues: one per task in the Next list of docs/memory/Memory-1-core.md, Memory-2-auth.md, Memory-3-storefront.md, Memory-4-admin.md, labelled window:<key>, with acceptance criteria.
12. Update Memory-main.md: contracts tag to be created, status "Phase 0 done — tag contracts-v0.1", and the next action ("run ./scripts/new-window.sh 1 1 and paste docs/start-messages/01-core.md").

Rules: ask before choosing any library not named in the plan. Do not build features. If a step would take more than ~20 tool calls, write the plan into Memory-main "Current status" and ask me to confirm before executing. When all 12 steps are done, tell me to run `git tag contracts-v0.1 && git push --tags`.

Memory rule: keep docs/memory/Memory-main.md current after every step and before every commit; commit it with the code. If context grows long, update it first, then run /compact.

Begin by listing the 12 steps with a one-line plan each and confirming docs/decisions.md has no <DECIDE> placeholders left. If it does, stop and ask me.
