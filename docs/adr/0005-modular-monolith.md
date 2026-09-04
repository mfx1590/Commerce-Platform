# ADR 0005 — Modular monolith: Medusa 2 core with owned modules, split out only what needs its own scaling

Status: accepted (Phase 0, 2026-09-04) · Owner: main window · Implemented by window 1 (`apps/core`) and module-owning windows

## Context

A solo operator running one Claude Code window at a time cannot operate a fleet of microservices, and the plan's
risk #4 warns against splitting early. At the same time, ownership must be disjoint per window so parallel phases
do not collide, and a few workloads (search indexing, accounting, analytics ingest) have different scaling and
failure profiles from request handling.

## Decision

1. **One deployable core: Medusa 2 in `apps/core`.** Built-in Medusa modules for cart, checkout, orders,
   inventory, pricing; our own modules for registry, hq-rbac, hq-warehouse, payments/tax/fraud adapters, shipping,
   search, promotions, customers, outbox. Same process, same database, same transaction boundary.
2. **Module boundaries are directory boundaries.** `apps/core/src/modules/<name>/{index.ts,README.md,tests}`. A
   module imports another only through its `index.ts` (public API) or through `packages/*`. ESLint
   `no-restricted-imports` enforces it (window 1 adds the rule with the first module).
3. **Ownership follows modules.** docs/ownership.md maps windows to module directories; CI's ownership check makes
   the boundary real. If two windows need the same file, the file is misassigned (plan 6.3) and the Integrator moves
   the shared part into a package.
4. **Shared kernel = packages.** `db` (tenancy), `events` (outbox contract), `contracts` (HTTP contract),
   `auth-sdk` (permission checks), `ui`, `test-utils`. Packages change only in Phase 0 and integration periods.
5. **Separate processes only for**: the outbox relay (window 14), the accounting consumer (`apps/accounting`), the
   analytics ingest (`apps/analytics-ingest`), notification workers (`apps/notifications`), search indexing jobs.
   They are consumers of events or jobs, never a second writer of core tables.
6. **HTTP is the only inter-app protocol; events the only fan-out.** No shared in-memory state, no direct database
   access from apps other than the core (consumers use their own tables or the API).
7. **Split criteria (Phase 6).** A module leaves the monolith only when it measurably needs independent scaling,
   a different runtime, or isolation from core failures, and only after its public API has been stable for a phase.

## Consequences

- Deploy = one core image + a handful of workers; local dev = docker-compose + `pnpm dev`.
- Medusa upgrades are a single-window task (window 1) and gate every other core module.
- Long-running flows (place order → reserve → capture → emit) use Medusa workflows with compensation, inside the
  monolith, not sagas across services.
- Tests: each module has unit tests against its public API and the tenant client; cross-module behaviour is
  covered by the Integrator's e2e suite.

## Alternatives rejected

- **Microservices from day one**: N deploys, distributed transactions for order placement, and no single owner per
  service in a one-window-at-a-time schedule.
- **Saleor / commercetools**: Python or managed; the plan fixed TypeScript and self-hosted ownership.
- **Custom cart/checkout/OMS**: plan risk #5; extend Medusa instead.
