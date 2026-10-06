# @platform/storefront-brand-a

Brand A's storefront — EU market, EUR, locales `en-GB` and `de-DE` (docs/decisions.md #2).
Generated from `apps/storefront-starter` per ADR 0004: the starter is a template, not a
dependency, and this app never imports from it. Owner: window 10 (brands).

For everything the app _does_ — the Store API client, routes, cart/checkout, locales, accounts,
attribution, the brand override pattern — read the starter's README: this app is that app, plus
the identity below. Documenting behaviour twice would only let the copies drift.

**Going live:** [`LAUNCH.md`](LAUNCH.md) is the launch checklist (#144): every item with its owner
window and the command that verifies it, the laptop dry run's results, and the owner actions still
open.

## Run it

```bash
pnpm mock                                          # Prism Store API on :4010
pnpm --filter @platform/storefront-brand-a dev     # brand A on :3101
```

Against the real core instead of the mock: start the core on :9000 with
`CORE_STORE_API_FALLBACK=1` and `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` (customers
routes still answer from Prism), then run this app with `STORE_API_URL=http://localhost:9000`.
Known gap until window 3's #109 lands: `next/image` rejects the seed's picsum thumbnails, so the
PLP renders without images against the core.

Brand A defaults (each overridable in the environment):

| Variable                | Brand A default                       | Set in                                    |
| ----------------------- | ------------------------------------- | ----------------------------------------- |
| `PORT`                  | `3101`                                | `scripts/start.mjs` (dev: `package.json`) |
| `SITE_URL`              | **none — required** in production     | every run sets it (see below)             |
| `STORE_PUBLISHABLE_KEY` | `pk_brand-a_dev_00000000000000000000` | `next.config.mjs`                         |
| `KEYCLOAK_CLIENT_ID`    | `storefront-brand-a`                  | starter default (no change)               |

**`SITE_URL` has no default, on purpose.** Since #320 every redirect, canonical, sitemap URL and
OIDC redirect URI is built on it, never on the request, and `siteUrl()` fails closed: a production
server started without it answers **500**. A default here would have answered `localhost:3101` from
a real deployment — the #298 defect. `next dev` and unit tests fall back to the starter's
`http://localhost:3100`, so set `SITE_URL=http://localhost:3101` for dev too if you sign in.
`playwright.config.ts` sets it for the e2e server; `scripts/perf.mjs` sets it to its own origin.

The publishable key is brand A's seeded dev key (`SEED_IDS.publishableKeys.brandA` in
`packages/db`; hashed in the database, public by design). The Store API resolves store `brand-a`
and its sales channel from it. `GET /health` answers 200 for the container HEALTHCHECK.

## Diff against the starter (the complete list)

Everything else is byte-identical to `apps/storefront-starter` at the commit of the last sync.

| File                                              | Why                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                    | **merged**, not preserved: name, version, dev port 3101, `sync`, `@axe-core/playwright`                                                                         |
| `LAUNCH.md`                                       | new — the launch checklist (#144)                                                                                                                               |
| `e2e/a11y.spec.ts`, `e2e/visual.spec.ts`          | new — axe and visual regression for the brand theme (#140)                                                                                                      |
| `src/app/icon.svg`, `src/app/opengraph-image.tsx` | new — brand favicon and default share card (#140)                                                                                                               |
| `scripts/start.mjs`                               | default port 3101                                                                                                                                               |
| `next.config.mjs`                                 | `STORE_PUBLISHABLE_KEY` default via `??=` (deliberately not `SITE_URL`); otherwise the starter, incl. #327's `E2E_LOCAL_IMAGES`                                 |
| `playwright.config.ts`                            | `APP_URL` :3101 and `SITE_URL` from it; mock `cwd` one level deeper; platform-keyed snapshots; otherwise the starter, incl. #327's 4-worker cap (`E2E_WORKERS`) |
| `lighthouserc.json`                               | none today — matches `scripts/perf.mjs`'s `127.0.0.1:3100` (the gate is vacuous, #283)                                                                          |
| `src/brand/config.ts`                             | `name` and `description` only; the rest tracks the starter (fail-closed `siteUrl()`)                                                                            |
| `tsconfig.json`                                   | `extends` path one level deeper (`../../../tsconfig.base.json`)                                                                                                 |
| `tailwind.config.ts`                              | kit-dist content glob one level deeper                                                                                                                          |
| `scripts/sync-from-starter.mjs`                   | new — the clone/re-sync script                                                                                                                                  |
| `scripts/merge-package-json.mjs`                  | new — the `package.json` merge rules                                                                                                                            |
| `scripts/starter-manifest.json`                   | new — **generated**: the starter's package.json at the last sync                                                                                                |
| `README.md`, `CHANGELOG.md`, `CLAUDE.md`          | this app's own docs (not copied)                                                                                                                                |
| `Dockerfile`                                      | window 5's file, delivered via REQUEST #197; excluded from the sync, not authored here                                                                          |
| `src/brand/**`                                    | the brand's design: `DESIGN.md`, `tokens.ts`, `fonts.ts`, `fonts/*.woff2`, `config.ts` (2.2)                                                                    |

## Theme

Brand A's design is authored in **[`src/brand/DESIGN.md`](src/brand/DESIGN.md)** — there is no
Figma, so that file is the design and the code is held to it. Change it there first.

In short: calm editorial D2C apparel. Five named colours (Paper `#F7F4EF`, Ink `#23201B`, Clay
`#9C4A32`, Sage `#5F6B57`, Stone `#6B6357`), every pair measured against WCAG and re-measured in
`test/brand-theme.test.ts`. Newsreader over Hanken Grotesk, self-hosted as woff2 under
`src/brand/fonts/` and loaded with `next/font/local` so no build and no page view touches
`fonts.gstatic.com`. Square corners, no shadows.

The theme ships entirely through tokens — brand A overrides no component or layout slot. The fonts
are wired through `tokens.ts` rather than a slot because the checkout and account layouts render no
`Header`, and a font injected from a slot would drop out there; see DESIGN.md §5.

### Checking the theme

```bash
pnpm --filter "@platform/storefront-brand-a^..." build   # workspace deps (ui, contracts, cms)
pnpm --filter @platform/storefront-brand-a build          # the app itself — Lighthouse needs a production build
pnpm mock                                                  # Prism Store API on :4010
```

then, with the app started as below, `pnpm --filter @platform/storefront-brand-a lighthouse` and
`… bundle-budget`. The app must be started with **`ROBOTS_ALLOW_INDEXING=1`**: `/robots.txt` fails
closed, and without it the SEO audit reads `Disallow: /` and lands around 0.58 rather than 0.92.

```bash
PORT=3101 STORE_API_URL=http://127.0.0.1:4010 SITE_URL=http://localhost:3101   ROBOTS_ALLOW_INDEXING=1 pnpm --filter @platform/storefront-brand-a start
```

Accessibility is checked by **axe over five pages, plus a contrast re-scan of the PDP**
(`pnpm … e2e a11y`), not by Lighthouse alone — Lighthouse audits only the PLP and PDP and scored
1.00 while the theme shipped a real AA failure in components that render on neither.

**This runs locally, and is not yet a CI gate.** Brand-storefront e2e journeys stay opt-in
(`E2E_INCLUDE_BRAND_STOREFRONTS=1`) until window 5 enables it (**#295**); #212 has landed, so
sign-in itself works. Run it by hand when you touch the theme. Visual baselines for home/PLP/PDP are opt-in
(`E2E_VISUAL=1`) and keyed by platform; see `e2e/visual.spec.ts` before regenerating one.

Measured on a production build (Lighthouse, median of 3): performance 0.97, accessibility
**1.00**, SEO 0.92, CLS 0.0000 / 0.0001 (PLP / PDP).

## CMS content

Brand A's published documents live in **[`cms/brand-a/`](../../../cms/brand-a/README.md)** — home,
two content pages, four EU legal pages, navigation, footer and one campaign landing, each in both
`en-GB` and `de-DE`. Seed them with `node cms/brand-a/scripts/seed-content.mjs` (`--dry-run` to
validate without credentials).

`test/cms-brand-content.test.ts` reads those files and renders them through the real route
components — `HomeContent`, `pages/[slug]`, `legal/[slug]` and `campaign/[slug]`, every document in
both locales — so the content is covered in CI without a Sanity dataset.

The axe suite also scans four content routes, but only when `CMS_DATASET` is set, and **nothing sets
it in CI today**, so those four are skipped there. The offline suite above is what actually gates
this content.

**The legal documents are not lawyer-reviewed.** See the warning in `cms/brand-a/README.md`.

## SEO and i18n

Brand A serves **`en-GB` and `de-DE`**, prices in **EUR**. `test/brand-i18n-seo.test.ts` covers the
brand-specific half — the starter's `test/seo.test.ts` and `test/i18n.test.ts` cover the helpers:

- **route rendering in both locales** — `e2e/routes.spec.ts` hits a real server and asserts 200,
  `<html lang>`, a self-referencing canonical and the full alternate set. Rendering is an HTTP
  property, so it is asserted over the real stack rather than through mocks. **Local only: nothing
  in CI runs it** (brand journeys are opt-in until **#295**, and `CMS_DATASET` is set nowhere in
  `.github`). Of 22 route renders, **8 run** — the four catalogue routes in both locales — and
  **14 skip** without a seeded Sanity dataset: `/pages/{about,cloth}`, `/legal/{imprint,privacy,
terms,returns}` and `/campaign/autumn-cloth`, each in both locales. Those content-route renders
  are **unverified**;
- the route **inventory is derived from the filesystem**, so a new route that nothing knows how to
  address fails the suite instead of being silently skipped;
- **both** message catalogues (`messages/` _and_ `src/lib/cms/messages/`) — same keys, same
  placeholders, German actually translated;
- JSON-LD priced in EUR with minor units converted, `Organization` named from `brandConfig`,
  breadcrumbs absolute and locale-prefixed;
- the sitemap, from the real module: every static path once per locale, each carrying the full
  language map; plus the paging boundary.

**Measured 2026-10-03** (production build on :3101 against the core, `SITE_URL` and
`ROBOTS_ALLOW_INDEXING=1` set, Lighthouse 12.6 mobile, three runs per URL):

- **SEO 1.00 on every run**: worst of three is 1.00 on `/en-GB`, `/en-GB/products`,
  `/en-GB/products/classic-tee` and `/de-DE/products`, with no failing SEO audit. Performance
  0.85–0.97, accessibility 1.00. (#274 fixed by #299; was 0.92.)
- **hreflang is in `<head>` in the served bytes**: description, canonical and the
  `en-GB`/`de-DE`/`x-default` alternates, on 7 routes × 4 user agents (desktop Chrome, Lighthouse
  mobile, Googlebot, none) × 2 requests each, so 280 checks with 0 failures. The sitemap carries
  alternates on all 422 URLs, all on the configured origin.
- **Content routes were not measured at runtime**: no Sanity project is configured locally, so they
  404 (and the e2e skips them without `CMS_DATASET`). Their sitemap inventory is asserted from brand
  A's real dataset in `test/brand-i18n-seo.test.ts`.

## Which backend answers what

Running against the core does **not** mean every request reaches it. With
`CORE_STORE_API_FALLBACK=1`, routes the core does not mount are proxied to Prism, so a green run can
still be exercising the mock. Measured on this stack:

| Request                                                             | Answered by                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/store`, `/store/products*`, `/store/carts*`, `/store/orders/{id}` | **the core** (a cart is a real UUID, not a contract example) |
| `/store/customers/me`, `/store/customers/me/orders`                 | **the core**, since #325 (closed #303)                       |
| sign-in redirect, return URL, session cookie, sign-out              | **the real Keycloak**                                        |

So `e2e/journey.spec.ts` exercises the core, **order history included**: its last test signs in, buys
and finds that order in the customer's history. `account.spec.ts` keeps the Keycloak half; its
`Order #1000` test is labelled mock-only and skips against the core.

## Stock budget

A full run against the core **places five real orders and consumes about five units**: the
inherited `checkout.spec.ts` journey (1), brand A's `journey.spec.ts` buy and order-history tests
(2), and the two buys `account.spec.ts` gained with #312 (2). All of them draw on a seed shared with
every other suite on the same publishable key. Brand A's tests buy from the deepest-stocked variant
in the catalogue, chosen by property at runtime, so no single product is drained. A day of heavy
iteration is tens of units; the shared seed is topped up to at least 25 available per variant
(`packages/db` top-up-stock, the manager's).

## End-to-end against the core

`e2e/journey.spec.ts` covers what the inherited `checkout.spec.ts` does not: **PDP variant
selection**, and the cart→checkout hand-off, against the core.

**Money is never arithmetic the spec does** (#374). The buy test compares the confirmation's total
with the **review step's** — captured by `completeCheckout()` before *Place order*, in minor units off
the page — because the review step is the last page to state the price and the first to state it with
delivery chosen. It once asserted `order == cart + delivery` instead, and #352 (delivery charged at
the goods' VAT rate) made a correct app fail by exactly that VAT. Adding up rows here re-states the
core's pricing rules in a place that does not own them; comparing two pages does not. The cart, priced
before delivery existed, is only a lower bound on the order.

**Order history against the core** (`journey.spec.ts`, "order history"): sign in as the realm's
verified customer, buy one unit, then find **that order id** in `/account/orders` at the confirmation's
total, and open it from there. Since the sync that brought #312, brand A sends the customer token on
cart create and completion, so the order is **linked to the customer at placement** and the history
lists it by that link. Needs Keycloak as well as the core.

Brand A's own specs wait for **hydration**, not for network idle (#327): `hydrated()` from
`e2e/support/journey.ts`, which reads the `data-hydrated` marker the layout sets. The visual spec also
waits for its images to finish loading. The e2e build serves local placeholder images, so no run
depends on picsum. Locally Playwright runs **4 workers**; `E2E_WORKERS` overrides.

`account.spec.ts` covers the **Keycloak** half — the sign-in redirect, the return URL, the session
cookie and sign-out.

**After every merge of main, rebuild the workspace packages before starting the core**
(`pnpm --filter @platform/auth-sdk build`, and contracts, db, events, cms, ui). A stale
`packages/auth-sdk/dist` read `email_verified` as absent, so every token looked unverified and order
history came back empty. That looks like a product bug and is not one.

```bash
# the shared stack must be up (Postgres 5433, Redis 6381, Keycloak 8180, OpenFGA 8081)
pnpm --filter @platform/auth-sdk fga:seed            # OpenFGA is in-memory; ids die with the container
pnpm --filter @platform/core exec tsx src/server.ts  # core on :9000

PORT=3101 STORE_API_URL=http://127.0.0.1:9000 SITE_URL=http://localhost:3101   ROBOTS_ALLOW_INDEXING=1 pnpm --filter @platform/storefront-brand-a start

E2E_REQUIRE_CORE=1 E2E_REQUIRE_KEYCLOAK=1   E2E_STORE_API_URL=http://127.0.0.1:9000 E2E_BASE_URL=http://localhost:3101   pnpm --filter @platform/storefront-brand-a e2e
```

**Without the stack every one of these skips**, so a laptop without it does not fail the suite. The
`E2E_REQUIRE_*` flags turn an unreachable backend into a failure instead — set automatically under
`CI`, so a silent skip cannot quietly stop covering the journey there.

The variant tests **find a product by property, not by handle**: they walk the listing until they
meet one whose first option group offers two or more selectable values. A handle in a test is the
fixture-coupling the starter's suite was rewritten to remove.

## Bundle budget

First-load JS per route, gzipped, against `bundle-budget.json`. Regenerate with
`node scripts/bundle-budget.mjs --sync-readme` after a build — the table below is written by that
command, so do not edit it by hand.

<!-- bundle-budget:start -->

| Route                                         | First load (gzipped) | Budget             |
| --------------------------------------------- | -------------------- | ------------------ |
| `/[locale]/(account)/account/orders/page`     | 130.6 kB             | 145 kB _(default)_ |
| `/[locale]/(account)/account/page`            | 133.1 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/cart/page`              | 139.7 kB             | 145 kB             |
| `/[locale]/(checkout)/checkout/address/page`  | 133.7 kB             | 139 kB             |
| `/[locale]/(checkout)/checkout/page`          | 129.4 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/checkout/payment/page`  | 133.7 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/checkout/review/page`   | 133.8 kB             | 139 kB             |
| `/[locale]/(checkout)/checkout/shipping/page` | 133.7 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/orders/[orderId]/page`  | 130.6 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/campaign/[slug]/page`    | 131.8 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/legal/[slug]/page`       | 131.8 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/pages/[slug]/page`       | 131.8 kB             | 145 kB _(default)_ |
| `/[locale]/(shop)/categories/[handle]/page`   | 136.2 kB             | 141 kB             |
| `/[locale]/(shop)/page`                       | 130.6 kB             | 136 kB             |
| `/[locale]/(shop)/products/[handle]/page`     | 139.2 kB             | 144 kB             |
| `/[locale]/(shop)/products/page`              | 136.2 kB             | 141 kB             |
| `/_not-found/page`                            | 102.8 kB             | 145 kB _(default)_ |

_Generated by `pnpm --filter @platform/storefront-starter bundle-budget --sync-readme`; budgets live in `bundle-budget.json`._
<!-- bundle-budget:end -->

## Re-syncing from the starter

When the starter gains a fix (take it by merging main — never the storefront window's branch):

```bash
pnpm --filter @platform/storefront-brand-a sync
```

`scripts/sync-from-starter.mjs` copies the starter's tracked files over this app, skipping the
excluded files and never overwriting the identity files or `src/brand/**` (the table above).
Review the resulting git diff — that is the drift, by construction.

`package.json` is neither copied nor preserved but **merged**
(`scripts/merge-package-json.mjs`): identity survives — name, version, the 3101 dev port,
brand-only scripts and dependencies — while scripts and dependency versions track the starter, and
anything the starter **deletes** is removed here too.

That last part needs a record of what the starter used to have, or a deleted key is
indistinguishable from one the brand added. `scripts/starter-manifest.json` is that record, written
by the sync script on every run and committed. It is generated — do not edit it by hand. With no
manifest (a fresh clone) nothing is treated as deleted, because dropping a real dependency for lack
of evidence is the worse failure.

Two rules follow, and they decide what "identity survives" actually means:

- **An identity key is never deleted.** A starter _rename_ — `dev` becoming `dev:web` — puts the old
  name in the record and not in the starter, which is indistinguishable from a deletion. Treating it
  as one would drop brand A's `--port 3101`, so the keep-set wins over the record.
- **A key both sides carry is starter-managed.** The starter's value wins while it exists, and the
  key goes when the starter drops it. A brand that needs to keep such a key says so by adding it to
  the keep-set, not by relying on having had it.
  Preserving it wholesale is what cost this app the `perf` and `bundle-budget` scripts for an entire
  task. A re-sync on an already-merged app writes a byte-identical file; `test/sync-merge.test.ts`
  asserts that, and both halves of the contract.

What the PRESERVE list costs, worth checking after any sync: **preserved files do not receive
starter fixes.** The 2026-10-03 re-sync found `next.config.mjs` (no `htmlLimitedBots`, no CSP frame
hosts, no security headers), `src/brand/config.ts` (no fail-closed `siteUrl()`),
`playwright.config.ts` (no warm-readiness server) and `lighthouserc.json` (no pessimistic SEO) all
behind. So every sync records the starter's blob id per preserved file in
`scripts/starter-preserved.json`, and both the sync and `--check` list each preserved file whose
starter counterpart changed since (`~` changed, `+` new, `-` gone). It reports and never fails:
port the change by hand, then the next sync clears the line.

## Test

```bash
pnpm --filter @platform/storefront-brand-a test        # Vitest (inherited from the starter)
pnpm --filter @platform/storefront-brand-a typecheck
pnpm --filter @platform/storefront-brand-a e2e         # Playwright; boots the mock + a prod build on :3101
```

The account e2e journeys need Keycloak (`pnpm compose:up`); they skip locally without it and are
required on CI. Lighthouse: build, start, then
`pnpm --filter @platform/storefront-brand-a lighthouse` (budgets: perf/a11y ≥ 90, LCP ≤ 2.5 s,
CLS ≤ 0.1).
