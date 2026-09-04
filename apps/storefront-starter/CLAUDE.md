# @platform/storefront-starter

## Purpose

Next.js App Router storefront template. Brand storefronts in apps/storefronts/<brand> are generated from it and override theme tokens, layouts, and content. Scaffold only in Phase 0.

## Owner

window 3 (storefront). (content) and src/lib/cms are window 6; (account) is window 13.

## Run / test

- `pnpm --filter @platform/storefront-starter build` — compile to dist/
- `pnpm --filter @platform/storefront-starter typecheck`
- `pnpm --filter @platform/storefront-starter test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/storefront-starter` before finishing any task.

## Public API

- Talks only to the Store API (`@platform/contracts/store`), in Phase 1 against `pnpm mock` (:4010)
- Sends `X-Store-Id` on every request (the API refuses requests without a store context)
- Route groups: (shop), (checkout), (account) (window 13), (content) (window 6)

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.

## Phase 0 note

This is a scaffold: package.json, tsconfig, an empty index.ts. The owning window replaces it with the real
framework setup (Medusa 2 / Next.js) in its first Phase 1 task. Keep the package name and the CLAUDE.md sections.
