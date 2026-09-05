# Memory 3 — Storefront starter & UI kit

Window: 3 · Key: `storefront` · Branch prefix: `storefront/` · Model: Opus (owner decision 2026-09-04)
Last updated: 2026-09-05 · Contracts: **0.2.0** · Branch: `storefront/phase1` (synced with main at `ce7558b`) · Status: 1.1 and 1.2 merged, 1.3 planned and awaiting the owner's go-ahead

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

- [x] **1.1 (#17) `packages/ui`: tokens, primitives, ThemeProvider** — commit `3306861`, PR #39.
      `defaultTokens` → `--ui-*` CSS variables; `ThemeProvider` (+ `parseTheme`, `mergeTokens`,
      `tokensToCssVars`, `cssVarName`); `Button`, `Input`, `Select`, `Card` family, `Dialog` (focus
      trap) + `DialogFooter`, `Badge`, `Price` (+ `formatMoney`, `minorUnitDigits`), `Skeleton`;
      `cn`, `variants`; `@platform/ui/preset` Tailwind preset. 35 Vitest tests green, typecheck,
      lint and prettier clean, `pnpm --filter @platform/ui build` emits dist/.

- [x] **1.2 (#18) Starter app skeleton, typed Store API client, brand override pattern** — commit `7b0a75f`
      (+ `b04a605`, `fba1cd4`, `80832fd`). Merged into main on 2026-09-05 **inside PR #39**, not as its own
      PR — see the worktree gotcha below. Issue #18 auto-closed by the commit trailer.
      Next 15 App Router on :3100 (React 19, Tailwind 3 via the kit preset); route groups `(shop)`
      `/` `/products`, `(checkout)` `/cart` `/checkout` with its own funnel chrome, `(account)`
      `/account`, `(content)` `/pages/[slug]` placeholder, plus `not-found`. Root layout resolves
      `store.theme` + `brandTokens` through `ThemeProvider` on `<body>`. `src/lib/store-api/` covers
      every Store API operation. Verified live against `pnpm mock`: `/` renders **Brand A** and its
      theme colour `#1E40AF` reaches `--ui-color-primary`; all routes 200, unknown route 404;
      `next build` green offline. 16 app tests + 37 kit tests.

## In progress

- **1.3 (#19) PLP + PDP — plan written, waiting for the owner to confirm before building.**
  Bigger than the ~20-tool-call budget in CLAUDE.md, hence the stop. Plan:
  1. `src/lib/catalog.ts` — `listProducts`, `listCategories`, `getProduct` wrappers with cache tags
     (`products`, `categories`, `product:<handle>`) and `revalidate`; all fetching on the server.
  2. `src/lib/variant.ts` — the option → variant resolver (`product.options` × `variants[].options`),
     plus `isAvailable` from `in_stock` / `available_quantity`. Pure and unit-tested.
  3. Components: `ProductCard` (next/image, `Price` with `compare_at_price` strike-through),
     `ProductGrid`, `Pagination`, `SortSelect`, `CategoryFilter` — filter/sort/pagination as plain
     links driven by `searchParams`, so the first render needs no client JavaScript.
  4. Routes: `/products` (page, category, sort, q), `/categories/[handle]`, `/products/[handle]`
     (option selectors as one small client component, `notFound()` on `isNotFound`).
  5. Caching: relax the root layout's `force-dynamic` so PLP/PDP can render statically with
     `revalidate` + tags; keep `getStoreOrNull` non-throwing so `next build` still works offline.
  6. Lighthouse mobile on PLP and PDP against `pnpm mock` — Chrome is present at
     `C:/Program Files/Google/Chrome/Application/chrome.exe`, so `npx lighthouse` can run without
     adding a dependency (the `lighthouserc` and `@lhci/cli` belong to task 1.7). Numbers recorded here.
  7. Tests for the resolver and the search-param parsing; README/CHANGELOG; PR.

## Next — Phase 1 (GitHub issues; acceptance criteria there are authoritative)

- [ ] 1.3 (#19) PLP (`/products`, `/categories/[handle]`) + PDP (`/products/[handle]`), `next/image`, fetch cache tags, option → variant resolver + unit tests, Lighthouse ≥ 90 mobile (record numbers here).
- [ ] 1.4 (#20) Cart + checkout steps (address, shipping, payment placeholder `manual`, review, `complete` with `Idempotency-Key`), confirmation page; error mapping 409 `out_of_stock` / 402 `payment_failed`.
- [ ] 1.5 (#21) Account + order history, Keycloak customers realm (`http://localhost:8180`, client `storefront-brand-a`), bearer token only on `/store/customers/*` and `/store/orders/{id}`.
- [ ] 1.6 (#22) i18n `next-intl` + multi-currency: `/[locale]/…`, `hreflang`, cookies, defaults from `store.default_locale` / `default_currency`, no hard-coded strings in `(shop)`/`(checkout)`.
- [ ] 1.7 (#23) Playwright smoke suite + `lighthouserc` budgets; CI job only via a `REQUEST:` issue (workflows belong to window 5 / main).

## Decisions made (with reasons)

- **PR flow (manager ruling, 2026-09-05, also in Memory-main global gotchas): ONE branch per window.**
  Stay on `storefront/phase1` for the whole phase. After each task: commit, open a PR from that
  branch, **wait for the manager to merge it (merge commit)**, then continue on the same branch — the
  next PR then contains only the new task. Never create stacked per-task branches; GitHub allows one
  open PR per branch, and stacking makes the merge order fragile. Window 3 got this wrong once: PR #47
  was opened from `storefront/phase1-task-1.2` and has been closed and the branch deleted.

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
- **The API client is the only module that knows the base URL, the key and the headers.** Pages get
  typed data; `Result<K>` / `Query<K>` / `Body<K>` are derived from `operations` in
  `@platform/contracts/store`, so a contract change is a compile error at every call site rather
  than a runtime surprise.
- **Customer tokens are allowlisted by path** (`allowsCustomerToken`): only `/store/customers/*` and
  `/store/orders/{id}` may carry a bearer token; anything else throws before the request is sent.
  Task 1.5's AC becomes a property of the client instead of a habit.
- **Phase 1 renders every route per request** (`dynamic = 'force-dynamic'` in the root layout): the
  layout itself calls `GET /store`, so prerendering would bake one snapshot and force the mock to run
  during `next build`. Task 1.3 adds per-route caching with fetch tags where it pays off.
- **`getStoreOrNull` never throws** — an API outage renders a readable card, and `next build` works
  offline. `getStore` (throwing) stays for pages that should 404/500.
- **Slot registries are lazy getters** (`getComponents()` / `getLayouts()`), because a default layout
  asks for a component slot; a getter keeps that independent of module evaluation order.
- **Brand override = three layers**: `src/brand/tokens.ts` (design tokens), `src/brand/{components,layouts}`
  (slots), and whole route files under `src/app/`. Documented in the app README with what a brand
  must *not* do (patch the kit, add business logic, import the starter after generation).
- **Tailwind 3 with a JS preset**, not Tailwind 4's CSS-first config: the kit's preset is a plain
  object mapping utilities onto the `--ui-*` variables, and v3 consumes it without a rebuild story.
- **`(content)` and `(account)` get layouts and placeholder pages only** — windows 6 and 13 own them
  later (docs/ownership.md); the routes exist so navigation and the 1.7 smoke suite are complete.

## Blocked / waiting

- Nothing blocking. 1.1 and 1.2 are merged; 1.3 is planned and waits only on the owner's go-ahead
  (CLAUDE.md's ~20-tool-call rule).
- Both filed issues are **accepted and on main** (merged into this branch on 2026-09-05):
  - **CONTRACT CHANGE #41** — `Store.theme` is documented as the `BrandTokens` shape; examples and
    the seed use the singular group names. Manager ruling: **keep the plural aliases in `parseTheme`
    as tolerance through Phase 1**; revisit in Phase 2.
  - **REQUEST #46** — `**/.next/` in `.prettierignore` and `**/next-env.d.ts` in the root eslint
    ignores. The local papercut below is gone.

## Gotchas learned

- **All worktrees share one object database and one set of refs** (`.git` here is a gitdir pointer to
  `commerce-platform/.git/worktrees/wt-storefront`). A branch is therefore *not* private to a
  worktree: commits made here on `storefront/phase1` are immediately visible to the manager's
  checkout, which can merge them without a push. That is how tasks 1.1 and 1.2 both landed in PR #39
  even though 1.2 was deliberately never pushed. Practical rule: **committing to the window branch is
  publishing.** If work must not be merged yet, do not commit it to `storefront/phase1` — keep it
  uncommitted or on a differently named local branch.

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
- The mock's Brand A theme is `{"colors": {"primary": "#1E40AF"}}` — group `colors`, while the kit's
  group is `color`. `Store.theme` is free-form in the contract, so this is not a contract violation:
  `parseTheme` now accepts the plural spellings as aliases, and **CONTRACT CHANGE #41** proposes
  documenting the `BrandTokens` shape and fixing the example. Not blocking.
- Tailwind loads `tailwind.config.ts` through jiti, which resolves package exports with the `require`
  condition. An ESM-only `exports` map with just `types` + `import` fails with "subpath is not
  defined"; `@platform/ui` now also declares `default`.
- `@platform/ui` must be listed in `transpilePackages` in `next.config.ts`, and its `dist/**/*.js`
  must be in Tailwind's `content` globs, or the kit's classes are purged.
- The app tsconfig overrides the repo base: `moduleResolution: Bundler`, `module: ESNext`,
  `jsx: preserve`, `noEmit`. Next needs those; the base's NodeNext does not work for an App Router app.
- Vitest needs the `@` alias declared in `vitest.config.ts` — tsconfig `paths` alone is not enough.
- `next build` must not need the API: with `force-dynamic` plus `getStoreOrNull`, it does not.
- Next's generated artefacts (`.next/types/**`, `next-env.d.ts`) used to fail the root
  `pnpm lint` / `format:check`; fixed on main by REQUEST #46 (2026-09-05). No workaround needed any
  more — but if the root checks ever complain about generated files again, that is the cause.
- After the manager applies a contract change, `pnpm install && pnpm --filter @platform/contracts build`
  before typechecking: the generated types are committed, but the local `dist/` the app resolves is not.

## How to run & test this package

```bash
# kit
pnpm --filter @platform/ui test        # 37 tests, jsdom
pnpm --filter @platform/ui typecheck   # src + test
pnpm --filter @platform/ui build       # dist/ (the app's Tailwind scan needs it)

# storefront (needs the kit and contracts built once: pnpm --filter @platform/contracts build)
pnpm mock                                          # Prism Store API on :4010
pnpm --filter @platform/storefront-starter dev     # :3100
pnpm --filter @platform/storefront-starter test    # 16 tests
pnpm --filter @platform/storefront-starter typecheck
pnpm --filter @platform/storefront-starter build   # next build, works offline

pnpm lint && pnpm format:check         # from the repo root
```

## Later phases (do not start until Memory-main says so)

### Phase 2 — Commerce complete, brand 1 live

Storefront polish for real API, SEO, structured data, sitemap, performance budget.

- [ ] Real Store API wiring
- [ ] SEO/metadata/sitemaps
- [ ] Perf budget in CI
