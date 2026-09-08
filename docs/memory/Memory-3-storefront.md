# Memory 3 — Storefront starter & UI kit

Window: 3 · Key: `storefront` · Branch prefix: `storefront/` · Model: Opus (owner decision 2026-09-04)
Last updated: 2026-09-07 · Contracts: **0.2.0** · Branch: `storefront/phase1` · Status: 1.1-1.6 merged (#39, #64, #66, #76, #96), 1.7 in PR #97, then 1.8 (#62) UTM capture closes Phase 1

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

- [x] **1.3 (#19) PLP + PDP against the mock, images via next/image** — commit `f5cb924`, PR #64.
      `/products` (search, category, sort, pagination) and `/categories/[handle]` share one
      `ProductListView`; `/products/[handle]` renders gallery, breadcrumb, description, tags and the
      `VariantPicker`. `src/lib/catalog.ts` (tagged reads + query parsing) and `src/lib/variant.ts`
      (pure resolver). 34 new tests → 50 in the app. **Lighthouse mobile, production build, against
      `pnpm mock`: PLP performance 99–100 (LCP 1.8–2.0 s, TBT 60–80 ms, CLS 0, a11y 100, SEO 91),
      PDP performance 100 (LCP 1.5 s, TBT 60 ms, CLS 0, a11y 100, SEO 100).**

- [x] **1.4 (#20) Cart + checkout steps against the mock** — commit `076d2e7`, PR #66. Cart at `/cart` (line items, quantity, remove); steps
      `/checkout/{address,shipping,payment,review}` with `/checkout` routing to what the cart needs;
      confirmation at `/orders/[orderId]`. All mutations are server actions in `src/lib/actions.ts`.
      `Idempotency-Key` stored as `<cartId>:<key>`. Error mapping for 409 out_of_stock / 402
      payment_failed / 409 cart_completed. Playwright journey green (4 consecutive runs incl. a cold
      build). 23 new unit tests → 72 in the app.

- [x] **1.5 (#21) Account + order history, Keycloak customers realm** — commit `73354a9`, PR #76. OIDC code+PKCE (S256) against realm `customers`, public client
      `storefront-brand-a`; route handlers `/account/{sign-in,callback,sign-out}`; tokens in an
      httpOnly cookie. `/account` = profile + addresses, `/account/orders` = history with `Price`
      and an empty state. `returnTo` restricted to same-site paths. Playwright: sign-in as seeded
      Jane, order `#1000` listed, sign-out ends the SSO session — 6 e2e green, 3 consecutive runs.
      16 new unit tests → 89. **Also REQUEST #68:** `next.config.mjs`, `start` honours `$PORT`,
      new `GET /health`.

- [x] **1.6 (#22) i18n (next-intl) + multi-currency** — commit `126ff6d`, PR #96.
      Locale routing under `src/app/[locale]/` with next-intl 4; catalogues `en-GB`/`de-DE`;
      `hreflang` + per-locale canonical; money formatted in the request locale; currency cookie
      validated against `store.currencies` and fixed on the cart at creation; language/currency
      switchers server-rendered. Route handlers (`/health`, `/auth/*`) stay outside the locale tree.
      35 new unit tests → 124, plus two e2e specs; 8 Playwright specs green.

- [x] **1.7 (#23) Playwright suite + Lighthouse config** — commit `82a1e8a`, PR #97.
      Config and docs only: infra's job (#80/#87) already runs the journeys. `lighthouserc.json`
      with the budgets; REQUEST #84 (conditional Chrome channel); account specs required when `$CI`
      is set. **Measured (2026-09-07, median of 3, mobile, production build):**
      PLP `/en-GB/products` perf **96**, a11y 100, LCP 2.08 s, TBT 187 ms, CLS 0;
      PDP `/en-GB/products/classic-tee` perf **99**, a11y 100, LCP 2.05 s, TBT 30 ms, CLS 0.
      First run was 89/85 — see the client-message fix below.

## In progress

- (nothing — 1.4 next, after the 1.3 PR merges)

<!-- superseded plan, kept for the record:
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
-->

## Next — Phase 1 (GitHub issues; acceptance criteria there are authoritative)

- [ ] 1.8 (#62) UTM / referrer capture into `cart.metadata.attribution` (added by the manager 2026-09-07).

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

- **`force-dynamic` belongs on pages, not on the root layout.** On a layout it forces `no-store` on
  every fetch below it, which would silently defeat the cache tags. It now sits only on `/`, `/cart`,
  `/checkout` and `/account` — pages with no cacheable data of their own that would otherwise be
  prerendered with the store baked in (CI builds with no API reachable at all). PLP/PDP cache at the
  fetch layer and `next build` still needs nothing running.
- **Listing state lives in the URL**, parsed by `parseListParams` and rebuilt by `listHref`. Filters,
  sort and pagination are links and a GET form, so the first render needs no JavaScript, every view
  is shareable and crawlable, and the PDP's `VariantPicker` is the only client component in the
  catalog.
- **The option → variant resolver is pure and lives outside React** (`src/lib/variant.ts`), so the
  server render and the client picker cannot disagree. `withOption` drops an option that a new choice
  makes impossible instead of leaving the selection stuck on a combination no variant satisfies.
- **Query strings are narrowed before they reach the API** — an unparseable `page`, `limit` or `sort`
  falls back to the default rather than producing a 400 from a hand-edited URL.

- **Checkout step reachability does not depend on `payment_session`** (accepted by the manager on
  2026-09-06 in the review of PR #66). The session is a PSP artifact
  with its own lifetime, not customer input: the customer picks a *method* at the payment step, and
  `placeOrderAction` creates the session immediately before authorising. Gating review on it would
  strand a customer whose session expired between steps — and it also made the review step
  unreachable against the stateless mock, which is what surfaced the problem.
  **Window 7 must revisit this for hosted fields:** Stripe needs `client_secret` while the customer
  is still on the payment step, so the session has to exist *before* review, not at place-order.
  Related: `createPaymentSessionAction` currently redirects and returns nothing, so the
  `client_secret` from `POST …/payment-session` is discarded — window 7 will need it on that page.
- **The idempotency key is stored as `<cartId>:<key>`** and validated on read, so a stale cookie can
  never attach a previous cart's key to a new order. Cleared on success.
- **Errors are mapped from the contract's `code`, never from messages** (`mapCheckoutError`), so the
  409/402 handling the AC asks for is a pure, unit-tested function rather than string matching.
  The `out_of_stock` payload is `details.available` — **not** `available_quantity`, which is the
  field name on `Variant` and the wrong guess I originally made (caught in review of #66).
  `available_quantity` is kept only as a fallback.
- **Open question for Phase 2 — the idempotency key is not rotated after a `402`.** A customer who
  clicks "try another method" retries `complete` with the same key. If the core caches error replies
  per key, that replays the decline instead of attempting the new payment; if it only caches
  successes, the retry is correct and the key is what stops a double charge. **Windows 7 and 1 own
  the decision in Phase 2**; the storefront follows whatever the core guarantees. Raised by the
  manager reviewing #66; no code change now.
- **Playwright drives the system Chrome (`channel: 'chrome'`)** instead of downloading browsers, and
  starts a *production* build — `next dev` differs enough around caching and server actions that a
  green dev run proves little.

- **`NextResponse.redirect()` defaults to 307, which preserves the request method.** Sign-out is a
  POST, so the browser was re-POSTing to Keycloak's logout endpoint, which does not end an SSO
  session that way: the customer was signed straight back in on their next visit. Fixed with an
  explicit 303. Caught by the e2e, not by review.
- **The account e2e specs run serially.** They share one Keycloak fixture user, and the sign-out
  test ends that SSO session server-side — in parallel it bounced a sibling test back to the login
  form mid-flow. That is what the first full-suite failure was.
- **Sign-out is POST-only**, so a prefetch or an image tag cannot sign a customer out, and
  `safeReturnTo` accepts only same-site paths so sign-in cannot become an open redirect.
- **No silent token refresh.** Cookies cannot be written during a render, so a page with an expired
  token redirects through `/account/sign-in`; Keycloak's SSO session makes that invisible to the
  customer. Window 13 can revisit with a server-side session store — the session currently lives in
  the cookie and is therefore bounded by ~4 KB.

- **Supported locales are build config, reconciled with the store at render.** Routing has to be
  decided in middleware, before any API call, so `SUPPORTED_LOCALES` (default `en-GB,de-DE`) drives
  the prefix and `assertStoreOffersLocale` 404s anything the store does not offer.
- **`localePrefix: 'always'`** — one canonical URL shape, no duplicate content between `/products`
  and `/en-GB/products`, and `hreflang` alternates that all look the same.
- **The cart is created in the request locale and the chosen currency**, not the store defaults —
  the contract fixes both at creation, so a `/de-DE` shopper paying in GBP must get a `de-DE`/`GBP`
  cart. `country` stays the store's: it is the market, not a preference.
- **Formatting follows the URL locale, not `store.default_locale`.** Using the store default meant
  `/de-DE` rendered `€19.99`; the acceptance criterion is exactly this, and it was wrong until the
  live check caught it.
- **Anything derived from a cookie must be *read back* from the cookie, not re-derived from the
  store.** The switcher and the footer showed `store.default_currency` while the cookie and the cart
  held the customer's actual choice: every layer was individually correct and the UI still lied.
  Review of #96 caught it; `test/currency-roundtrip.test.ts` now walks switcher → cookie → cart.
- **Currency is a cookie, not a path segment.** The same URL priced in EUR or GBP is the same page,
  so it does not belong in the URL; it is validated against `store.currencies` before use and fixed
  on the cart at `POST /store/carts`, as the contract requires.
- **Route handlers stay outside `[locale]`**: `/health` must answer the probe without a redirect and
  `/auth/*` has a callback URL registered with Keycloak. Everything else redirects through
  `redirectLocalized`.

- **`NextIntlClientProvider` ships the whole catalogue unless told otherwise**, and that alone kept
  PLP and PDP under the Lighthouse budget (89/85, on blocking time — LCP and CLS were always fine).
  Passing only the namespaces the `'use client'` components use took PDP TBT from 530 ms to 30 ms.
  The budget earned its place immediately: nothing else would have surfaced this.
- **Playwright browser choice is conditional** (REQUEST #84): local Chrome, CI chromium.
  `infra/ci/run-e2e.sh` decides what to install by grepping the config for a pinned
  `channel: 'chrome'`, so that literal must not appear in the source when CI runs — it is computed.

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

- **A conflicted branch means GitHub runs no CI at all** — PR #96 sat with zero checks, not failing
  ones, because `pnpm-lock.yaml` conflicted with main. Merge main *before* asking for review, or the
  greens being reported are from a stale commit. Resolve the lockfile with `git checkout --theirs
  pnpm-lock.yaml && pnpm install`, never by hand.
- Layout/component slots are React Server Components and one may be `async` (the footer reads a
  cookie), which `ComponentType` cannot express — `src/lib/slots.ts` types them as
  `(props) => ReactNode | Promise<ReactNode>`.
- The app's `tsconfig` sets `jsx: preserve` for Next, so Vitest needs `esbuild: { jsx: 'automatic' }`
  or importing a component in a test fails with "React is not defined".
- An async server component can be tested by calling it directly and walking the returned element
  tree — no DOM, no RSC renderer. That is how the switcher's selected value is covered.

- **next-intl logs `MISSING_MESSAGE` and renders the key name — it does not throw.** A typo ships as
  visible rubbish and every end-to-end assertion still passes; `checkout.confirmation.deliveryAddress`
  did exactly that. `test/i18n.test.ts` now resolves every `t('...')` call against the catalogue, and
  the check was verified by deleting a key and watching it fail.
- `redirect()` from `next/navigation` drops the locale prefix and lands on a route that does not
  exist. Use `redirectLocalized`, and **`return`** it: `await` does not narrow control flow, so TS
  reports "function lacks ending return statement" and the code after it stays reachable.
- Vitest cannot resolve next-intl's own `next/navigation` import from inside pnpm's isolated store;
  `test.server.deps.inline: ['next-intl']` makes Vite resolve it from the app.
- Moving pages under `[locale]` means the root layout moves too — `<html lang>` has to be the locale
  being rendered, so `app/layout.tsx` is deleted and `app/[locale]/layout.tsx` is the root.

- The realm seeds Jane's username as **`jane@example.com`**, not `jane` as issue #21 says; the
  password is `jane`. Keycloak's login page needs `#username` / `#password` locators — a
  label-based locator matches the password input *and* its "Show password" toggle.
- Keycloak is a container, not a `pnpm` script, so Playwright does not start it. The account specs
  skip when it is unreachable unless `E2E_REQUIRE_KEYCLOAK=1` — CI must set that (task 1.7) or a
  missing dependency would pass quietly.
- **Never run `pnpm dev --reset` while other windows are building.** It is
  `docker compose down -v`: it wipes every volume (Postgres, Redpanda, Keycloak) and then exits
  without bringing the stack back up, destroying the other windows' database and seed state.
  `pnpm dev --down` stops without wiping; `pnpm dev` boots and re-seeds.
- **Keycloak now persists realms** (`KC_DB: dev-file` in the keycloak volume, "imported once, then
  kept"). A restart no longer re-imports them, so the note in Memory-main's global gotchas about
  re-importing on every start is out of date. The only refresh paths are
  `node infra/keycloak/reimport.mjs <realm>` or wiping the `keycloak-data` volume.
- **Compose mounts `../keycloak` from *this worktree*.** Re-importing or recreating Keycloak from a
  worktree whose realm JSON is behind main installs the stale realm for everybody. Check
  `git diff origin/main -- infra/keycloak/` before touching Keycloak, and merge main first.

- **The Prism mock is stateless and answers from the contract's examples.** `CartWithItem` already
  has email, address and a delivery option, so the e2e journey enters checkout at the payment step;
  a PATCH never changes what the next GET returns. Any flow whose guard depends on state the mock
  cannot persist will loop — that is how the payment-session gating bug above was found. It also
  means `GET /store/products/{handle}` returns the example for *any* handle, so a 404 path cannot be
  exercised end to end.
- The e2e journey failed **once**, on the very first (cold, 4-worker) run, then passed four times
  including a fresh cold build. The artifacts were cleared before I could read them, so the cause is
  not established — worth watching when task 1.7 puts this in CI.
- `redirect()` signals by throwing, so in a server action it must be called **outside** the
  `try/catch` around the API call, or the redirect is swallowed as a failure.
- Writing a cookie is only allowed in a server action or route handler, never while rendering a
  page — hence `getCart()` (read, page-safe) being separate from `getOrCreateCart()` (action-only).

- **Lighthouse must be run against `next start`, never `next dev`** — dev is unoptimised and scores
  meaninglessly low. Chrome is at `C:/Program Files/Google/Chrome/Application/chrome.exe`; set
  `CHROME_PATH` and use `npx -y lighthouse@12 … --chrome-flags="--headless=new --no-sandbox"`; no
  dependency needed (the budgeted `lighthouserc` belongs to task 1.7).
- **Next streams metadata into `<body>` when the root layout's `generateMetadata` is async**, and it
  is here because it awaits `GET /store` for the title template. React hoists the tags at hydration,
  but Lighthouse only counts metas in `<head>`, so the PLP scores `meta-description` = 0 even though
  the tag is present and correct in the DOM (verified). Cost: SEO 91 instead of 100 — performance,
  the actual acceptance criterion, is unaffected. **Phase 2 SEO task: take the brand name from build
  config instead of the API so root metadata is static.**
- The API returns `seo.canonical` as a *path*; without `metadataBase` Next emits it relative and
  crawlers reject it. `metadataBase` is set from `SITE_URL` (default `http://localhost:3100`).
- The mock's product media are `res.cloudinary.com/demo/...` URLs that 404, so PLP/PDP show empty
  image boxes and Lighthouse reports `errors-in-console`. Mock data, not a defect.
- `next build` fails with `EPERM … .next/trace` while a dev or start server is running on the same
  `.next`. Stop the server first (`netstat -ano | grep :3100`, then `taskkill //PID <pid> //F`).

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
pnpm --filter @platform/storefront-starter test    # 124 tests
pnpm --filter @platform/storefront-starter e2e     # Playwright, starts mock + prod build itself
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
