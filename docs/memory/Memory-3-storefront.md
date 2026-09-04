# Memory 3 — Storefront starter & UI kit

Window: 3 · Key: `storefront` · Branch prefix: `storefront/` · Model: Opus (owner decision 2026-09-04)
Last updated: 2026-09-04 · Contracts: `contracts-v0.1` · Branch: `storefront/phase1` · Status: task 1.1 done, 1.2 next

## Identity (does not change)

Owned paths (write):

- `apps/storefront-starter/**`
- `packages/ui/**`
- plus `docs/memory/Memory-3-storefront.md`, `.claude/CLAUDE.local.md`, `pnpm-lock.yaml` (allowed by scripts/check-ownership.sh)

Reads:

- packages/contracts (mock API, types from `@platform/contracts/store`)
- design tokens export

Never touches:

- apps/core
- apps/admin
- cms/ schemas

## Mission — Phase 1 (Isolated modules)

Next.js App Router storefront template and shared UI kit with a brand override mechanism (tokens, layout slots, component overrides). Pages: home, PLP, PDP, search, cart, checkout steps, account, order history, content pages. All data from the mock Store API. i18n + multi-currency from day one. Lighthouse ≥ 90 on PLP/PDP. Playwright smoke tests.

Parallel mode since 2026-09-04: windows 1, 2, 4, 5 build at the same time in their own worktrees.
Never wait for them, never pull their branches. There is no real Store API — everything runs against
the Prism mock on `http://localhost:4010` (header `X-Publishable-Key`, any value).

## Done

- [x] **1.1 (#17) `packages/ui`: tokens, primitives, ThemeProvider** — commit `<pending>`, PR `<pending>`.
      `defaultTokens` → `--ui-*` CSS variables; `ThemeProvider` (+ `parseTheme`, `mergeTokens`,
      `tokensToCssVars`, `cssVarName`); `Button`, `Input`, `Select`, `Card` family, `Dialog` (focus
      trap) + `DialogFooter`, `Badge`, `Price` (+ `formatMoney`, `minorUnitDigits`), `Skeleton`;
      `cn`, `variants`; `@platform/ui/preset` Tailwind preset. 35 Vitest tests green, typecheck,
      lint and prettier clean, `pnpm --filter @platform/ui build` emits dist/.

## In progress

- (nothing — starting 1.2 next)

## Next — Phase 1 (GitHub issues; acceptance criteria there are authoritative)

- [ ] 1.2 (#18) Starter app skeleton: App Router route groups `(shop)` `(checkout)` `(account)` `(content)`, root layout with `ThemeProvider`, typed Store API client from `@platform/contracts/store` sending `X-Publishable-Key`, brand override folders `src/brand/{tokens.ts,components/,layouts/}`. Dev port **3100**, `MOCK_API_URL=http://localhost:4010`; renders the mock store name from `GET /store`.
- [ ] 1.3 (#19) PLP (`/products`, `/categories/[handle]`) + PDP (`/products/[handle]`), `next/image`, fetch cache tags, option → variant resolver + unit tests, Lighthouse ≥ 90 mobile (record numbers here).
- [ ] 1.4 (#20) Cart + checkout steps (address, shipping, payment placeholder `manual`, review, `complete` with `Idempotency-Key`), confirmation page; error mapping 409 `out_of_stock` / 402 `payment_failed`.
- [ ] 1.5 (#21) Account + order history, Keycloak customers realm (`http://localhost:8180`, client `storefront-brand-a`), bearer token only on `/store/customers/*` and `/store/orders/{id}`.
- [ ] 1.6 (#22) i18n `next-intl` + multi-currency: `/[locale]/…`, `hreflang`, cookies, defaults from `store.default_locale` / `default_currency`, no hard-coded strings in `(shop)`/`(checkout)`.
- [ ] 1.7 (#23) Playwright smoke suite + `lighthouserc` budgets; CI job only via a `REQUEST:` issue (workflows belong to window 5 / main).

## Decisions made (with reasons)

- **Tokens live only as CSS custom properties.** `ThemeProvider` writes `--ui-<group>-<name>` as
  inline styles on its wrapper; the Tailwind preset maps `bg-primary`, `text-2xl`, `rounded-md`, …
  onto them. A brand therefore restyles at runtime from API data — no rebuild, no per-brand CSS
  bundle, which is what ADR 0004 (storefront per brand) needs.
- **`ThemeProvider` is hook- and context-free** (no `createContext`, no `'use client'`), so it works
  as the root of a React Server Component tree. Consequence: there is no `useTheme`; client code
  reads tokens through CSS variables. `Dialog` is the only `'use client'` module.
- **`Price` takes an explicit `locale` prop** (default `en-US`) instead of reading a context — keeps
  it server-renderable on PLP/PDP. Task 1.6 will inject the request locale from next-intl.
- **`Store.theme` is free-form JSON in the contract**, so `parseTheme` narrows it: unknown groups,
  unknown keys and non-string values are dropped. No CONTRACT CHANGE needed — the token shape is
  owned by `@platform/ui` (`BrandTokens`).
- **Native `<select>` for `Select`** — correct keyboard/screen-reader behaviour everywhere, works in
  a no-JS form post, and no popover library to maintain.
- **`Dialog` renders in place, not in a portal**, so it inherits the ThemeProvider's CSS variables.
- **Only two runtime deps added** (`clsx`, `tailwind-merge`); `cva` is replaced by a 20-line local
  `variants()` helper in `src/lib/variants.ts`.
- React 19 (matches Next 15) as a peer dependency; dev deps: Testing Library (react/dom/user-event/jest-dom), jsdom, @types/react(-dom).

## Blocked / waiting

- (none)

## Gotchas learned

- `exactOptionalPropertyTypes: true` in `tsconfig.base.json`: an optional prop that is forwarded
  (`variant?: 'a' | 'b'`) must be typed `… | undefined` at the receiving end, or TS2379.
- `@testing-library/user-event` under `moduleResolution: NodeNext`: `import userEvent from …` types
  as the module namespace and `.setup` is missing. Use the named export
  `import { userEvent } from '@testing-library/user-event'`.
- ESLint `no-irregular-whitespace` fires on a literal NBSP inside a regex. `Intl` separates the
  amount and the currency symbol with U+00A0 (or U+202F), so tests must normalise with the escapes
  `/[  ]/g`, never the raw characters.
- Test files are not in the build `tsconfig.json` (`rootDir: src`). `tsconfig.test.json` typechecks
  them; `typecheck` runs both.
- `tsc` preserves the `'use client'` directive in `dist/`, so the compiled package works as a Next
  client boundary.
- Writing files with `Bash` heredocs mangles backslash escapes in this environment — use the Write
  tool for source files (matches the note in the operator's own memory).

## How to run & test this package

```bash
pnpm --filter @platform/ui test        # 35 tests, jsdom
pnpm --filter @platform/ui typecheck   # src + test
pnpm --filter @platform/ui build       # dist/
pnpm lint && pnpm format:check         # from the repo root
```

## Later phases (do not start until Memory-main says so)

### Phase 2 — Commerce complete, brand 1 live

Storefront polish for real API, SEO, structured data, sitemap, performance budget.

- [ ] Real Store API wiring
- [ ] SEO/metadata/sitemaps
- [ ] Perf budget in CI
