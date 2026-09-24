# Memory 3 — Storefront starter & UI kit

Window: 3 · Key: `storefront` · Branch prefix: `storefront/` · Model: Opus (owner decision 2026-09-04)
Last updated: 2026-09-24 · Contracts: contracts-v0.4.4 (Store API 0.3.1; the `currency` query is in use since 2.1) · Branch: `storefront/phase2` · Status: **Phase 2 complete for this window** — 2.1–2.3 merged, 2.4 in PR

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

## Mission — Phase 2 (Commerce complete, brand 1 live)

Storefront polish for real API, SEO, structured data, sitemap, performance budget.

Wave C — starts when cms 2.2 and core 2.2 have merged.

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

- [x] **1.8 (#62) UTM / referrer capture into `cart.metadata.attribution`** — commit `8e22664`, PR #101. Captured in the middleware into `sf_attribution` (httpOnly, 30 days); first
      touch never overwritten, last touch updated, no cookie without a marketing signal. Sent at
      `POST /store/carts` and via `PATCH` before `complete`. Verified live: campaign landing →
      cookie, second campaign → `last` only, ordinary visit → no cookie; Prism accepts the body on
      both endpoints (201/200). 20 new unit tests → 157. **CONTRACT CHANGE #100 filed:** `metadata`
      is absent from contracts-v0.1 entirely, contrary to the issue's premise.

- [x] **Follow-up to #100** — the local `metadata` type extension in `src/lib/cart.ts` is deleted;
      the bodies now come straight from the contract (Store API 0.2.0). `CartMetadata` had to become
      a type alias: the contract declares `metadata` with an index signature, and only a type alias
      gets the implicit index signature that satisfies it. No behaviour change. Commit `b8c613d` —
      it landed **inside PR #101**, which was still open when it was pushed, rather than the separate
      small PR the manager asked for: one branch means one open PR.

- [x] **2.1 (#109) Real Store API wiring** — commit `016d056`, **PR #204 merged** (merge commit
      `f6ac558`, 2026-09-09). Closes #102; folds in REQUEST #169 (`9cb3204`, `@platform/ui` 0.3.0),
      REQUEST #178 (`a52e635`) and #167's documentation lines (`f050020`) as three self-contained
      commits in the same PR. All 12 CI checks green, Playwright included.
      The core is the default backend (`STORE_API_URL` wins, `MOCK_API_URL` selects Prism, the
      unconfigured default moved from the mock to `http://localhost:9000`). `currency` (Store API
      0.3.0) is sent on `listProducts`/`getProduct` from the reconciled currency cookie, so PLP/PDP
      prices follow the switcher. Error mapping gained 401 `unauthorized` /
      `invalid_publishable_key` / `forbidden` and 409 `conflict`. `picsum.photos` allowed in
      `remotePatterns` scoped to `/seed/**`. The Playwright journey is data-independent.
      213 app tests (15 files) + 47 kit tests green; lint, typecheck, format, `next build` green.
      **Not verified: the e2e run against the core** — see In progress and #203.

- [x] **2.2 (#110) SEO: metadata, structured data, sitemap, canonical/hreflang** — commit
      `9192ac4`, **PR #254 merged** (merge commit `0184334`, 2026-09-21); closes #110 and #199.
      Three commits: `50c2b2c` CSP (#199), `9192ac4` the task, `e812908` the `form-action` fix for
      sign-out that CI's account e2e caught. (This entry first said `1c17497` — see the gotcha on
      amending a commit to record its own SHA.)
      `src/brand/config.ts` (new, **fourth brand-override layer — announced to window 10**) holds
      the static identity so root metadata never awaits `GET /store`. `src/lib/seo.ts` is the pure
      core: `alternatesFor` (canonical + `hreflang` + `x-default`), `canonicalFor`, `productJsonLd`
      (one `Offer` per variant), `breadcrumbJsonLd`, `organizationJsonLd`, the sitemap paging maths.
      `/sitemap.xml` is a hand-written index over Next's `/sitemap/<n>.xml` pages; `/robots.txt`
      refuses everything outside production. PDP gains `Product` + `BreadcrumbList` JSON-LD and an
      `next/og` share card; home gains `Organization`. CSP imports `EMBED_HOSTS` from
      `@platform/cms` so it cannot drift from window 6's Studio validation.
      292 app tests (21 files) + 47 kit tests; lint, typecheck, format, `next build`, Playwright
      (5 passed / 4 skipped — Keycloak not running locally) and Lighthouse all green.

- [x] **2.3 (#111) Performance budget in CI and image pipeline** — commit `a77fd86`, **PR #256
      merged** (merge commit `009e250`, 2026-09-24). Two further commits in it fixed defects that
      existed only in a built image: `5d64315` (CSP per request in the middleware — sign-out was
      blocked in every deployed image) and `cb30ed5` (robots.txt per request, indexing opt-in).
      `pnpm --filter @platform/storefront-starter perf`: production build against the mock, bundle
      budget, `next start`, Lighthouse CI, server always stopped, one exit code, both gates always
      run. **Proven both ways:** PDP bundle budget 100 kB → exit 1, LCP budget 100 ms → exit 1 (a
      real measurement failure, ~2 050 ms), restored → exit 0, via both `pnpm perf` and plain
      `node scripts/perf.mjs`. `bundle-budget.json` + `scripts/bundle-budget.mjs` (no dependency):
      home 130.5, PLP 136.0, PDP 139.0, cart 139.5 kB, budgets measured + ~5 kB. `ProductImage` is
      the image-CDN seam; `@platform/ui/image-loader` subpath (kit 0.4.0). Fonts and third-party
      scripts: a documented zero budget the CSP enforces. **Also fixes two defects in 2.2 that exist
      only in a built image** (see Decisions): the CSP moved to the middleware, robots.txt is per
      request and opt-in. REQUEST to window 5 filed with the PR (perf job + Helm values).
      312 app tests (24 files) + 47 kit tests; lint, typecheck, format, `next build`, e2e green.

- [x] **2.4 (#112) Marketing hooks: referral landing, review display, feed-friendly PDP data** —
      PR pending (SHAs go in the next commit). **Closes Phase 2 for this window.**
      `/r/{code}` outside `[locale]` and excluded from the middleware matcher: records the code as a
      marketing touch through the same `readTouch`/`mergeAttribution` path as `?ref=`, so it reaches
      the order as `cart.metadata.attribution.*.ref` with no contract change. Code and `?to=` both
      narrowed (`src/lib/referral.ts`); 302 so the hop is never cached. PDP review block
      (`src/lib/reviews.ts`, `src/components/product-reviews.tsx`) renders nothing without data,
      states the rating as text with the stars `aria-hidden`, `<time datetime>` per review; reviews
      read from `product.attributes.reviews` until **CONTRACT CHANGE #270** lands. Window 6's
      `HomeContent` mounted on `/` (REQUEST #178) so campaign embeds reach the shop. Feed data (GTIN,
      brand, per-variant availability) already shipped in 2.2's JSON-LD. Plus the three #256 review
      nits — see Decisions. 339 app tests (26 files) + 47 kit tests; lint, typecheck, format,
      `next build`, `perf`, and the new `/r/` e2e (3 specs) green.

## In progress

- **2.1 (#109) is code-complete and in PR; one acceptance criterion could not be verified.**
  See Done below for what shipped. **The e2e run against the core did not happen: the core does not
  boot on main** — `apps/core/src/jobs/index-products.ts` (window 9, `d258257`) is a CLI script with
  no Medusa job `config`, and the `JobLoader` refuses the boot before :9000 ever binds. Filed as
  **#203** and confirmed there with a clean reproduction: the bootstrap check, Redis, the fallback
  proxy and every other Medusa loader succeed first, so it really is only that file. Everything else
  in 2.1 is green against the mock, and the suite is written so the same spec runs against the core
  the moment it starts. **Re-run this the day #203 lands** — it is 2.1's one unmet acceptance
  criterion and nobody else will notice it is outstanding:
  `E2E_STORE_API_URL=http://localhost:9000 pnpm --filter @platform/storefront-starter e2e`.
  PR #204 merged with the gap recorded in its description.

- **2.2 (#110) — SEO ≥ 95 deviation ACCEPTED by the manager (2026-09-21):** the budget stays at 90;
  the README records the deviation and the partial-prerendering revisit. Background, kept for the
  revisit: **"Lighthouse SEO ≥ 95" is not reliably reachable on these routes.**
  What I found, measured rather than assumed: Next emits page metadata in `<head>` only when it
  resolves before the shell is flushed; otherwise the tags are appended to `<body>` and React hoists
  them at hydration. The DOM is correct either way — every e2e assertion passes — but Lighthouse's
  `meta-description` audit and a raw-HTML crawler see nothing. Taking `GET /store` out of the root
  layout's metadata removed the biggest cause, and it is a real improvement. It did **not** make
  placement deterministic: both catalogue routes still render dynamically because pricing reads the
  currency cookie, so with a cold fetch cache the metadata can still be flushed late. **The same
  build measures SEO anywhere between 92 and 100.** A 95 gate would therefore be flaky, so the
  budget stays at 90 and the README explains why. Making it deterministic means making the catalogue
  routes statically renderable, i.e. taking per-request currency out of the server render — a trade
  against the behaviour 2.1 shipped deliberately, and the manager's call, not mine. Worth revisiting
  when partial prerendering is stable in Next.

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

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)

- [ ] **Review nits from #254, still deferred by the manager ("not now"):** (a) the comment in
      `src/app/[locale]/layout.tsx` cites `test/seo-head.test.ts`, **which does not exist** — the
      head-placement check was done by hand against the built HTML, so either write that test or
      drop the reference; (b) `apps/storefront-starter/.gitignore` lists `.lighthouseci/` twice.

## Decisions made (with reasons)

- **The referral code is recorded through the existing touch path, not a parallel one.** `/r/{code}`
  builds the same `readTouch` input a `?ref=` visit would, so first-touch preservation, the 4 KB cap
  and the no-PII rule are inherited rather than re-implemented — and window 17's reporting reads the
  field it already reads.
- **A referral link is public input twice over.** The code is shape-checked (no dots: a dot reads as
  a file extension to the middleware matcher) and `?to=` must be a path on this site, because an open
  redirect on a referral link lets anyone borrow the brand's domain. An unusable code still
  redirects: a mistyped link is a customer worth keeping, and it simply records nothing.
- **The review block renders nothing, not an empty state.** "No reviews yet" on every product of a
  new catalogue announces that nobody has bought anything. And **no `aggregateRating` in JSON-LD**
  until the data is real — Google treats an uncorroborated rating as a rich-result violation, and an
  average of `0` would read as "rated zero out of five".
- **Every route is in the bundle budget, via `routes.default`.** An unlisted route was silently
  unchecked, which is how a budget quietly stops protecting anything; but requiring an entry per
  route would fail windows 6 and 13 for a file they are not allowed to edit.
- **The README's budget table is generated and verified.** Budgets had two copies — the file and a
  hand-written table — free to drift. The block is now rendered from the measurement, and the gate
  fails if the routes or budgets differ. Only the budget column is enforced: failing a build because
  a first-load figure moved 200 bytes would train everyone to ignore it.

- **Nothing that differs per environment may be decided at build time.** The deployment model is
  one image, configured per environment at runtime (Helm `env:` per values file). Anything baked by
  `next build` — `next.config.mjs` `headers()`, static routes, prerendered pages — therefore carries
  the build machine's values everywhere. Two 2.2 defects were exactly this: the CSP's `form-action`
  held `http://localhost:8180` in every deployed image (sign-out blocked everywhere), and a static
  `robots.txt` said `Allow: /` in every image (`next build` always runs with
  `NODE_ENV=production`, so the "outside production" check never fired). The fix is structural: the
  CSP is built per request in the middleware, robots.txt is `force-dynamic`. **The earlier advice to
  make `KEYCLOAK_URL` a build argument was wrong** — a build argument cannot carry per-environment
  values into one image — and the REQUEST says so rather than quietly dropping it.
- **Indexing is opt-in (`ROBOTS_ALLOW_INDEXING=1`), not inferred.** A forgotten flag on production
  is noticed the same day; staging in an index outranks the real site and takes weeks to undo.
- **The image-CDN seam is a client component, not `images.loaderFile`.** A loader file switches the
  app to `loader: 'custom'`, and Next then disables `/_next/image` entirely — every non-Cloudinary
  image would 404. A `loader` prop cannot be passed from a server component (functions do not
  serialise). `ProductImage` chooses per image on the client side of that boundary.
- **The bundle budget counts layouts; `next build`'s column does not.** Next's "First Load JS"
  counts only a page's own entry (~1.6 kB less per `[locale]` route). A budget on Next's figure
  under-counts exactly the header and footer a brand grows.
- **Lighthouse runs as an exact `npx` pin, not a devDependency.** `@lhci/cli` added ~950 lockfile
  lines; a devDependency puts that in every install of every window for one CI job.
- **Tools are resolved, not looked up on `PATH`.** `perf.mjs` runs Next's CLI through
  `require.resolve` + `process.execPath`, because `next` is on `PATH` only under `pnpm`; run with
  plain `node`, the server never started and the script reported it as a Lighthouse failure.

- **Brand identity is build configuration; everything priced or per-store stays API data.**
  `src/brand/config.ts` exists because metadata that awaits `GET /store` resolves too late to reach
  `<head>`. The line is drawn at identity (name, description, canonical origin) — prices,
  availability, locales and the theme still come from the Store API, so a brand cannot drift from
  what it actually sells by editing a config file.
- **A relative `seo.canonical` from the API is localised; an absolute one is obeyed.** The API
  returns a locale-less path because it does not know which locale is rendering, and using it
  verbatim pointed the canonical at a URL that only redirects. An absolute value is a deliberate
  cross-site pin (a syndicated product naming its origin) and is left alone.
- **The sitemap is paged in URLs, not products**, because every path appears once per locale — the
  distinction is invisible until a two-locale store passes 2 500 products. `/sitemap.xml` is a
  hand-written index because Next publishes none for `generateSitemaps`, and both read the same
  `sitemapPaths()` so the index can never advertise a page that 404s.
- **A failed catalogue read degrades the sitemap instead of failing it.** A short sitemap costs
  crawl efficiency; a 500 tells the crawler the whole file is broken and it backs off from all of it.
- **The CSP imports `EMBED_HOSTS` from `@platform/cms` rather than copying the host list.** It is
  the same list window 6's Studio validates an editor's embed URL against, so a copy that drifts
  would either block an embed the Studio accepted or permit one it rejected.
- **The Lighthouse SEO budget stays at 90, deliberately, and the README says why.** The score moves
  between 92 and 100 on the same build (see In progress); a 95 gate would be flaky, and turning off
  the `meta-description` audit to force a pass would hide a real signal.

- **A test may assert on our own copy; it may never assert on the dataset.** That is the line the
  Phase 1 e2e crossed, and it is why the suite could not run against the core: the fixture's product
  name, handle, price and SKU were baked into the journey, along with the mock's stateless cart that
  always opened checkout at the payment step. The journey now takes whatever the first product is,
  reads its name off the page, and drives whichever step it lands on. Message-catalogue copy, roles
  and structure are ours and are stable; a product name is not.
- **`currency` is passed into the catalog reads explicitly rather than resolved inside them.**
  `src/lib/catalog.ts` stays free of `next/headers`, so it remains a pure, directly-testable module;
  the two call sites (PLP view, PDP loader) resolve `getCurrency(await getStoreOrNull())`, both of
  which are `cache()`d per render, so metadata and page still share one request. Both PLP and PDP
  route groups already read a cookie in the layout, so nothing became dynamic that was not.
- **The unconfigured default is the core, and `MOCK_API_URL` is what selects Prism.** Precedence is
  `STORE_API_URL ?? MOCK_API_URL ?? core`. Playwright and CI set `MOCK_API_URL` explicitly, so they
  keep their contract-example run without needing the stack, while a developer who configures
  nothing gets the real thing — which is the behaviour that was wrong before.
- **The attribution cookie is capped by reducing `last`, never `first`** (#102). Values are
  truncated on both touches first; only if that still does not fit is `last` reduced to the fields
  that identify a campaign. The first touch is what acquired the customer, so it is the one that
  must survive — the same reasoning that makes `mergeAttribution` never overwrite it.
- **The `content` namespace merge is tolerant of window 6 not having shipped yet** (#178). A hard
  `import` of `src/lib/cms/messages/<locale>.json` fails the whole request while that folder is
  empty; next-intl's own behaviour for a missing message is to log and render the key, so failing
  louder than the library does would turn "window 6 has not shipped its strings" into a broken
  storefront rather than an untranslated `(content)` route.

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

- **First touch is never overwritten; last touch always is.** Crediting the last campaign for the
  first one's work is the entire failure mode this feature exists to avoid, so it is a property of
  `mergeAttribution` and is tested directly, not an incidental result of the write order.
- **Only the referrer's origin is stored.** A full referring URL routinely carries a query string
  with an email address in it; the origin is all attribution needs, and a test asserts no PII
  survives serialisation.
- **Attribution is refreshed onto the cart before `complete`, and never fatally.** `complete` has no
  request body (see #100), so the last touch has to be `PATCH`ed onto the cart first; a failure
  there is logged and swallowed, because losing a marketing attribute must not cost the order.

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

- **The perf gate failed on its own defaults, and I reported it green from a stale run.** 2.3 added
  `perf` and changed `robots.txt` to `Disallow: /` unless `ROBOTS_ALLOW_INDEXING=1`, in the same PR.
  The `perf` run I quoted happened before the robots change; afterwards Lighthouse's
  `is-crawlable` audit fails and SEO drops from ~92 to **58**, so the CI job in REQUEST #257 would
  have failed the first time it ran. `perf` now sets the variable, because it measures the
  configuration that ships. **Re-run every gate after the last change in a PR, not after the last
  change you happened to be thinking about.**

- **A `public/*.html` file would be served with no CSP.** The middleware matcher skips anything with
  a file extension and the policy now lives only in the middleware, so a static HTML page in
  `public/` is a document with no policy at all. This app ships no `public/`; a brand that adds one
  must serve such a page as a route rather than widen the extension rule, which exists to keep the
  middleware off every image and script.
- **A route outside `[locale]` needs the middleware matcher changed, not just the file.** Without
  adding `r/` to the exclusion, `/r/CODE` is rewritten into `/en-GB/r/CODE` and 404s. Unit tests
  cannot see this — it is why `/r/` has an e2e spec.
- **Walking a rendered tree in a test stops at a child component** unless the walker invokes it: the
  `aria-hidden` stars live inside `<Stars>`, so the first version of the a11y assertion passed
  vacuously against a tree that did not contain them. A test helper that silently sees less than the
  page does is worse than no test.
- **A namespaced `getTranslations` mock must carry the namespace.** Mocking it as
  `() => (key) => key` makes every assertion about a message key match the wrong string, so the test
  agrees with itself and not with the page.

- **`next.config.mjs` `images.loader: 'custom'` disables `/_next/image` entirely** — requests to
  it 404, including for hosts `remotePatterns` allows. A "custom loader with a fallback to the
  optimiser" cannot exist; choose the loader per image instead. Verified with a production server.
- **Middleware reads `process.env` at runtime** (unlike `next.config.mjs` `headers()`): built with
  no `KEYCLOAK_URL`, started with the staging value, the middleware-set header carried the staging
  origin. `next.config.mjs` `env: {…}` is the way to hand it a genuine build-time constant.
- **A package barrel without `sideEffects: false` is not tree-shaken.** Importing three pure
  functions from `@platform/ui` cost 1.5 kB of first-load JS per image route; a dedicated subpath
  export cost 0.2 kB. The bundle budget is what surfaced it.
- **Python reading a heredoc on Windows mis-decodes non-ASCII**, so a `str.replace` anchored on text
  containing `──` or `—` silently fails to match a UTF-8 file. Anchor on ASCII-only lines, or write
  the script with the Write tool and run it with `python -X utf8`.
- **`git show origin/main:path` is mangled by Git for Windows** (`origin\main;path`); prefix
  `MSYS_NO_PATHCONV=1`.
- **The deployed storefront has never had `SITE_URL` set** (Helm dev/staging values), so its OIDC
  redirect URI is `http://localhost:3100/auth/callback` — sign-in cannot work there. Phase 1 code,
  window 5's values; in the 2.3 REQUEST.

- **Never amend a commit to record that commit's own SHA.** Amending changes the SHA, so the value
  just written down is immediately false — 2.2 was recorded as `1c17497` while the commit that
  merged is `9192ac4`, and the manager caught it in review. A commit cannot contain its own hash.
  Record a SHA in the *next* commit, or write "this commit" and let the log answer.

- **`form-action 'self'` breaks OIDC sign-out, silently and only in a browser.** Chrome evaluates
  `form-action` against the URL **after** redirects, so a POST to our own `/auth/sign-out` that
  answers `303` to Keycloak's `end_session` endpoint is blocked outright — the local cookie is
  already gone, the SSO session survives, and the customer is signed straight back in. Nothing on
  the page looks wrong; `curl` sees a perfectly good 303. Caught by the account e2e on CI (which
  requires Keycloak, where locally it skips) and reproduced in the browser console. The policy must
  list the identity provider's origin.
- **`headers()` in `next.config.mjs` is evaluated at BUILD time**, even though `next start` loads
  the config file at runtime — the headers are written into the routes manifest. Verified by
  building with one `KEYCLOAK_URL` and starting with another: the built-in value wins. Anything
  environment-dependent in a header must therefore be set at image build time, or moved to the
  middleware (which the matcher would limit to non-`/auth`, non-`/api` routes).

- **`localhost` resolves to `::1` on this machine and nothing listens there.** Every local HTTP
  check must use `127.0.0.1` — `curl http://localhost:4010/store` returns 000 while the Prism
  container is plainly up and serving, and `lighthouserc.json` could not connect to a running
  server until its URLs were changed. This wasted real time twice, and it is also why a "the core is
  not answering" conclusion should always be confirmed from the process log rather than from curl.
- **Next puts page metadata in `<head>` only when it resolves before the shell is flushed.**
  Otherwise the tags go at the end of `<body>` and React hoists them at hydration: the DOM is
  correct, every Playwright assertion passes, and Lighthouse's `meta-description` audit still fails.
  It is timing-dependent, not a static property — the same build scores 92 with a cold fetch cache
  and 100 with a warm one. Do not conclude "fixed" from one curl; measure repeatedly.
- **`generateSitemaps()` serves `/sitemap/<n>.xml` and publishes no `/sitemap.xml` index.** A
  `robots.txt` pointing at `/sitemap.xml` therefore advertises a 404. Verified by requesting it,
  not assumed.
- **Lighthouse writes `.lighthouseci/` into the package**, which `pnpm format:check` then flags in
  26 files. Gitignored locally; the root `.prettierignore` line belongs to the main window, and CI
  never sees the directory, so it is only a local annoyance — worth folding into 2.3's REQUEST to
  window 5 if the Lighthouse job ever shares a runner with the format check.

- **`/tmp` is shared by every worktree on this machine — never use a predictable name there.**
  All windows run on one Windows box, so `/tmp/<something>.log` is one file for all of them.
  Hit twice on 2026-09-09: `/tmp/pr-body.md` still held **window 5's** infra PR text when I went to
  create mine (`gh` would have opened the PR with the wrong body if the write had not failed first),
  and `/tmp/core-dev.log` was being written by **window 9's** core in `../wt-search`, so I was
  reading another window's boot errors as though they were mine. Same hazard class as the shared git
  stash. Use the session scratchpad directory instead; if a temp file must be read back, check it is
  really yours (the paths inside a stack trace name the worktree that produced it).
- **The core does not boot on main (2026-09-09, issue #203).** `apps/core/src/jobs/index-products.ts`
  is a CLI script with no `config` export, and Medusa's `JobLoader` scans `src/jobs/` at boot and
  requires one from every file: "Config is required for scheduled jobs", before :9000 binds. Nothing
  caught it because the core's tests mount `mountCoreMiddleware` on a bare Express app and never run
  Medusa's loaders — the hq-rbac lesson again. **Check :9000 answers `/health` before planning any
  work that depends on the core.**
- **`playwright.config.ts` sets the app server's env explicitly**, so the repo-root `.env` is not
  what decides the backend in an e2e run. Next only reads `apps/storefront-starter/.env*` anyway;
  the root `.env` reaches a process only when something loads it (the core does, via `loadDotenv()`).
  A worktree has no `.env` of its own until `pnpm dev` writes one — `cp .env.example .env` is enough
  to run the core locally, and it is gitignored.
- **`page.waitForURL(<pattern matching the current URL>)` returns immediately**, so a loop that
  advances through steps re-processes the step it is already on: the second pass clicks a button the
  first submit has already disabled (`aria-busy`), and the click hangs until the test times out.
  Wait for the URL to *change* (`(url) => !url.pathname.endsWith('/' + step)`), not merely to match.
- **Server-action forms detach their submit button at hydration** (`useActionState` replaces the
  server-rendered form), so a click landing in that window fails with "element was detached from the
  DOM". Waiting for the step's `<h1>` and `networkidle` before acting is what makes it deterministic.
- **Rebuild `@platform/contracts` before believing a typecheck failure about contract types.** The
  generated sources are committed but the `dist/` the app resolves is not, so a freshly merged
  contract version reports as missing properties (`'currency' does not exist on type …`) until
  `pnpm --filter @platform/contracts build`. Running package scripts directly also skips turbo's
  `^build`, which is why the cms suites fail to resolve `@platform/cms` unless it is built first —
  the root `pnpm test --filter …` does it for you.

- **`metadata` does not exist anywhere in the Store API spec** (`grep -c metadata store-api.yaml`
  → 0), despite issue #62 stating it was free-form in contracts-v0.1. `completeCart` has no request
  body at all either. Check the spec before believing an issue's description of it —
  CONTRACT CHANGE #100. Prism accepts the extra field because no schema sets
  `additionalProperties: false`, which is what makes building ahead of the contract possible here.
- Heredocs mangle `
` inside string literals (the operator's own memory says as much). Multi-line
  string fixtures belong in a file written with the Write tool — `test/fixtures/directives.ts`.

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
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API;
  `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against
  the core with `STORE_API_URL=http://localhost:9000`
  (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes
  still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package

```bash
# kit
pnpm --filter @platform/ui test        # 37 tests, jsdom
pnpm --filter @platform/ui typecheck   # src + test
pnpm --filter @platform/ui build       # dist/ (the app's Tailwind scan needs it)

# storefront (needs the kit and contracts built once: pnpm --filter @platform/contracts build)
pnpm mock                                          # Prism Store API on :4010
pnpm --filter @platform/storefront-starter dev     # :3100
pnpm --filter @platform/storefront-starter test    # 157 tests
pnpm --filter @platform/storefront-starter e2e     # Playwright, starts mock + prod build itself
pnpm --filter @platform/storefront-starter typecheck
pnpm --filter @platform/storefront-starter build   # next build, works offline

pnpm lint && pnpm format:check         # from the repo root
```
