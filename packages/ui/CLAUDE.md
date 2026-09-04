# @platform/ui

## Purpose

Shared storefront UI kit: theme tokens, primitives (Button, Input, Price, ProductCard, ...) built on Tailwind + shadcn/ui conventions. Brands override tokens, not components.

## Owner

window 3 (storefront).

## Run / test

- `pnpm --filter @platform/ui build` — compile to dist/
- `pnpm --filter @platform/ui typecheck`
- `pnpm --filter @platform/ui test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/ui` before finishing any task.

## Public API

- `import { Button, Price, ProductCard, ThemeProvider, defaultTokens } from '@platform/ui'` (window 3 fills this in Phase 1)
- Tokens contract: `packages/ui/src/tokens.ts` — one object per brand overriding `defaultTokens`

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.
