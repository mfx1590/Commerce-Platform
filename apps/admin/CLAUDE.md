# @platform/admin

## Purpose

Next.js App Router admin application. One app, two views (Store view and HQ view) decided by OpenFGA permissions via @platform/auth-sdk; every API call is re-checked server-side. Scaffold only in Phase 0.

## Owner

window 4 (admin). src/app/(hq)/bi/** is window 12 (embed only).

## Run / test

- `pnpm --filter @platform/admin build` — compile to dist/
- `pnpm --filter @platform/admin typecheck`
- `pnpm --filter @platform/admin test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/admin` before finishing any task.

## Public API

- Routes: `src/app/(store)/**` store-scoped screens, `src/app/(hq)/**` HQ-only screens
- Talks only to the Admin API (`@platform/contracts/admin`), in Phase 1 against `pnpm mock` (:4011)

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.

## Phase 0 note

This is a scaffold: package.json, tsconfig, an empty index.ts. The owning window replaces it with the real
framework setup (Medusa 2 / Next.js) in its first Phase 1 task. Keep the package name and the CLAUDE.md sections.
