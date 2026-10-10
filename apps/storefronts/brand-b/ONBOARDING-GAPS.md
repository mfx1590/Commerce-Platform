# Onboarding a brand: what still needed a developer

Written while creating brand B (#437), as the input to **#438** (`new-brand.mjs`, which automates the
mechanical half and whose first run is brand C).

The question this answers is narrow and deliberate: **not** "what would a nice generator do", but
"what did a developer actually have to decide, type or notice to get brand B from nothing to a green
suite". Every item names the file and why.

Brand B had an unfair advantage worth stating up front: **its store already existed in the seed** —
store row, legal entity, GBP currency, GB tax rate, products, domain, publishable key, and the
Keycloak client `storefront-brand-b`. So #437 cloned an **app**, not a business. § 6 covers what a
brand that is _not_ in the seed still needs.

---

## 1. Mechanical — a script can do all of this (#438's target)

> **Written before #438, and #438 proved it optimistic.** The script does do all of this, and brand
> C exists. But generating a brand whose locale the starter does not serve turned up five defects
> this list does not mention (traps 13-17), one of which meant the generated app could not render a
> single page. "Mechanical" meant "mechanical for a brand shaped like brand B". **And the list below
> is not quite right about the content set either** — it calls the document set fixed, and the
> generator wrote half of it until the #444 review counted (trap 24). Read section 3 before trusting
> this one.

| Step                          | File                                                                 | Why it is mechanical                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy the three sync scripts   | `scripts/{sync-from-starter,merge-package-json,preserved-drift}.mjs` | Byte-identical from any existing brand. **Do not copy `starter-manifest.json` or `starter-preserved.json`** — those are the _other_ brand's records, and a new brand's first sync would read them and think the starter had moved. |
| Run the clone                 | `node scripts/sync-from-starter.mjs`                                 | Needs no first-run flag: `previousStarter`/`previousPreserved` fall back to `undefined`, and MERGE and PRESERVE both fall through to a plain copy when the target is missing. 220 copied, 4 excluded.                              |
| Path depth                    | `tsconfig.json`, `tailwind.config.ts`                                | One `../` each. A brand lives one level deeper than the starter.                                                                                                                                                                   |
| Port                          | `scripts/start.mjs`, `playwright.config.ts`, `package.json` (`dev`)  | One number, three files.                                                                                                                                                                                                           |
| Package identity              | `package.json`                                                       | `name`, and the dev port. The merge rules keep these and track the starter for everything else.                                                                                                                                    |
| Publishable key               | `next.config.mjs`                                                    | `process.env.STORE_PUBLISHABLE_KEY ??= …`.                                                                                                                                                                                         |
| `lighthouserc.json`           | —                                                                    | **Copy from an existing brand, not the starter**: the starter is still `numberOfRuns: 3`, and the brand copies carry `5` from #348. Copying the starter's would silently re-introduce a flaky perf gate.                           |
| Content and manifest skeleton | `cms/<brand>/**`                                                     | The document _set_ and the file layout are fixed; only the prose and the slot list change.                                                                                                                                         |

**Derive a new brand from an existing BRAND, not from the starter.** That is the single most useful
rule here. The brand copies carry fixes the starter does not have: `numberOfRuns: 5` (#348), the
`STORE_PUBLISHABLE_KEY ??=` line in `playwright.config.ts` (#382), platform-keyed visual snapshots,
and the deliberate refusal to import `RUNTIME_SITE_URL` (#379). A generator seeded from the starter
would reproduce three solved bugs.

---

## 2. Decisions — a script must ASK, and cannot default

| Decision                   | Where it lands                          | Why a default is wrong                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The brand's name**       | `src/brand/config.ts`                   | "Stonecrop" is a developer's working name for brand B. A generator should take it as an argument and refuse to invent one. Recorded as owner action 0.1 on `LAUNCH.md`.                                                                                                      |
| Meta description           | `src/brand/config.ts`                   | It is marketing copy.                                                                                                                                                                                                                                                        |
| **Locale list**            | `next.config.mjs` → `SUPPORTED_LOCALES` | See § 3. The starter's default is two locales; B sells one.                                                                                                                                                                                                                  |
| Theme tokens               | `src/brand/tokens.ts`                   | A palette is a design decision. B took a system font stack **on purpose** — a licensed webfont is a purchase, and #348 showed A's hero LCP is render-delay bound, so a font download is the easiest way to make a new brand slower than the brand it was copied from.        |
| Whether to ship font files | `src/brand/fonts/`                      | Brand A has them; B has none. A generator should not create an empty `fonts/`.                                                                                                                                                                                               |
| Campaign and page slugs    | `cms/<brand>/content/*.json`            | B has `made` and `winter-weight` where A has `cloth` and `autumn-cloth`.                                                                                                                                                                                                     |
| Legal jurisdiction         | `cms/<brand>/content/legal.json`        | **The biggest non-mechanical item.** Brand A's imprint cites German statutes; B's cite the Consumer Rights Act 2015, the Consumer Contracts Regulations 2013 and UK GDPR/ICO. A generator can supply the four documents' _structure_ and placeholder names, never their law. |

---

## 3. Traps that cost time, in the order they bit

1. **A new workspace package needs a plain `pnpm install`, not `--frozen-lockfile`.** The lockfile has
   no importer for it, so `@playwright/test` and the rest never link and `typecheck` dies with
   `Cannot find module '@playwright/test'` across every e2e file — which reads like a broken clone
   rather than a missing install.
2. **`LOCAL_DEVELOPMENT_SITE_URL` belongs to the starter, not the brand.** It is in
   `src/brand/config.ts`, which looks brand-owned, but synced starter tests assert `:3100`. Changing
   it to the brand's port breaks six of them. **Brand A left it alone for exactly this reason**, so
   brand A's local-dev default origin is `:3100` while brand A runs on `:3101`. That is a genuine
   wart in the starter, not something to fix per brand — the app's real port lives in
   `scripts/start.mjs` and `playwright.config.ts`.
3. **`src/brand/config.ts` is not the tokens file.** It holds `brandConfig` _and_ ~65 lines of the
   starter's fail-closed `siteUrl()` machinery (`SiteUrlError`, `LOCAL_DEVELOPMENT_SITE_URL`,
   `parseSiteUrl`) from #298/#320. Tokens go in `src/brand/tokens.ts`. Overwriting the wrong one
   destroys the origin handling, and in a fresh clone the file is **untracked**, so git cannot
   restore it.
4. **Read the other brand's real documents before copying their shape.** Three schema guesses were
   wrong and `validateDocument` caught all three: `cta` requires `variant`; `footerColumn` uses
   `heading`, not `title`, and its children are `_type: 'link'`, not `navItem`; `legal.body` is a
   richText **object** with `content`, not a bare array.
5. **The locale list is set by environment, not by a brand file.** `src/i18n/routing.ts` is **synced**
   and defaults `SUPPORTED_LOCALES` to `'en-GB,de-DE'`. A one-locale brand must set it in
   `next.config.mjs`; editing `routing.ts` would be drift the next sync undoes. **A brand that
   forgets would serve a German URL space with no German content** — brand B's `e2e/journey.spec.ts`
   tests for it.
6. **The shared e2e helper fills a NETHERLANDS address, so a brand that ships elsewhere cannot
   complete checkout.** `e2e/support/journey.ts`'s `completeAddressStep` hard-codes
   `Keizersgracht 1, 1015 CJ, Amsterdam, NL` with no override. Brand B ships to **GB only**
   (`shippingCountries: ['GB']` in the seed), so its delivery step answers "No delivery options are
   available for this address" — correctly — and **four inherited funnel tests time out**: the
   checkout journey, the signed-in buy, the stale-session buy and the order lifecycle. I found three
   by running and the fourth only on the next run — count them by running, not by reading. This was the single biggest
   surprise in #437, and it looks like a broken storefront rather than a helper that assumes brand
   A's market. **#441 part 3** asks for the address to come from the brand or the environment.
   Brand B works around it by excluding those four in its own `playwright.config.ts` and walking the
   funnel itself in `e2e/journey.spec.ts` with a GB address, place-order → ship → deliver included —
   so the proof is kept, not dropped. **A generator must not assume the inherited funnel specs will
   pass for a brand outside the starter's market.**

7. **The OIDC client id defaults to BRAND A.** `src/lib/auth/oidc.ts`:
   `clientId: env.KEYCLOAK_CLIENT_ID ?? 'storefront-brand-a'`. A new brand that does not set it
   signs its customers in through brand A's Keycloak client — and because the `store_code` claim is
   stamped **per client**, the brand would mint sessions scoped to `brand-a`, which the core's
   `verifyCustomerToken(token, storeCode)` is right to refuse. It surfaces as Keycloak answering
   **"Invalid parameter: redirect_uri"** (brand A's client does not allow the new brand's port),
   which reads like a realm misconfiguration and is not. Set
   `process.env.KEYCLOAK_CLIENT_ID ??= 'storefront-<brand>'` in the brand's `next.config.mjs`.
   **#441 part 2** asks for the default to fail closed instead, as `siteUrl()` already does.

8. **Unit tests do not see that setting.** Vitest does not load `next.config.mjs`, so brand B's unit
   suite still runs the starter's two-locale default while the app serves one. Not wrong, but not
   brand B either. The clean fix is in the starter's `vitest.config.ts` (window 3's file): read
   `SUPPORTED_LOCALES` from the environment so a brand can set it in one place. **Not filed yet** —
   it needs the shape agreed with window 3 first.

9. **A new workspace package must be `COPY`ed in EVERY existing Dockerfile's deps stage.**
   `infra/ci/check-image-manifests.sh` requires each image's deps stage to copy every workspace
   `package.json`, so adding `apps/storefronts/brand-b` turned the **`app images`** CI job red
   across all eight existing Dockerfiles — none of which brand B touches, and all of which are
   window 5's (`**/Dockerfile`). A brands window cannot fix this and should not try: it is a
   manager integration landing, alongside the new brand's own Dockerfile and bake target (#439).
   **Expect `app images` to be red on the PR that creates a brand**, and say so in the PR body
   rather than leaving a reviewer to wonder.

10. **The shared local database can be stale in a way that silently disables checkout.**
    `packages/db`'s seed sets `payment.invoice_allowed` for every store (0.3.2), but `seed` is
    **`ON CONFLICT DO NOTHING`** — so a long-lived local database keeps its old `store.settings` and
    `GET /store` answers `payment.methods: []`. The storefront then renders "No payment method is
    available for this shop right now" and **no order can be placed locally**, while CI, which seeds
    fresh, is fine. Brand B hit exactly this: brand A's row had been updated by hand during #358 and
    brand B's never was.
    The remedy is the `UPDATE` recorded in `packages/db/CHANGELOG.md` 0.3.2 — but it writes to the
    database **every window shares**, and nothing would tell the others, so it is an owner/manager
    action, not a brands-window one. **What a brand should do instead:** read `GET /store` at the top
    of any spec that places an order and **skip with the cause and the remedy**, which is what
    `e2e/journey.spec.ts` does — and print it, see trap 12.

11. **A skipped test is invisible in CI unless the spec prints why.** Playwright's github reporter
    does not name skipped tests, and a reason handed to `test.skip()` never reaches the log. So a leg
    where the load-bearing proof quietly did not run looks exactly like one where it passed. Caught
    in review of #442, not by me. Print a line on **both** paths — one naming the order on success,
    one naming the reason on skip — and print the skip line **before** `test.skip()`, which throws.

12. **Two inherited e2e specs hard-code the starter's two locales, and excluding them costs real
    coverage.** `e2e/seo-head.spec.ts` declares `const LOCALES = ['en-GB', 'de-DE']` and derives both
    its page matrix and its `hreflang` count (`LOCALES.length + 1`) from it; `e2e/checkout.spec.ts`
    navigates to `/de-DE/products` and asserts the alternates of a two-locale site. Brand B emits two
    alternates (`en-GB` + `x-default`) and does not serve `/de-DE`, so 14 tests fail against a correct
    app. Both files are synced, so brand B excludes them in its own `playwright.config.ts`.

    **Say the cost out loud: brand B has no `<head>` metadata assertion at all.** That is the one
    exclusion in #437 that loses coverage rather than relocating it — the NL-address three were
    replaced by brand B's own funnel spec, these were not. `e2e/journey.spec.ts` covers the locale
    behaviour that matters (`en-GB` served with `lang="en-GB"`, `/de-DE` not served as de-DE), which
    is not the same as asserting the tags are inside `<head>`. **#441 part 1** asks window 3 to derive
    the list from the app's own routing; the exclusion comes out the day it lands.

---

13. **THE BIG ONE: brand B proved nothing about cloning, because B's locale is one of the
    starter's.** The starter serves `en-GB` and `de-DE` and writes those into its synced files as
    literals. Brand B sells `en-GB`, so every literal B inherited happened to be right and the clone
    looked clean. **Brand C sells `en-US` and nothing inherited is right** — measured by grep, not
    guessed: **8 synced spec files, 43 `en-GB` occurrences**, plus `scripts/e2e-server.mjs`'s
    warm-up path and `lighthouserc.json`'s two collect URLs.
    Three consequences, which need three different answers:
    - **`lighthouserc.json`** is the brand's (PRESERVED), so it can be fixed: it was measuring two
      `/en-GB` 404s and reporting the result as a performance score. The generator now SUBSTITUTES
      this file rather than copying it byte for byte.
    - **`scripts/e2e-server.mjs`** warms `/en-GB` before declaring the app ready, and **e2e fails
      BEFORE the first test** — which looks nothing like a failing test. **Measured on brand C**
      (2026-10-09), and not by the mechanism anyone would guess. `GET /en-GB` on brand C answers **307** with `location: /en-US/en-GB` — next-intl treats the unknown locale as a path segment under the default one. 307 is under 400, so the warm-up's `timed()` counts the page as a **success**: the log reads `page 5 ms` on every one of 120 attempts. What never succeeds is the **chunk**, because the warm-up discovers its path by regex out of the page body and a **12-byte** redirect body contains no `/_next/static/chunks/…`. So `chunkPath` stays null, `chunk` is null forever, and `warmUp()` throws after 120 s.
      The error it prints is actively misleading:
      ```
      [e2e-server] the app on http://127.0.0.1:3103 did not answer a page and a static chunk under 1000 ms 2 times in a row within 120 s
      ```
      The page was never slow. It answered in single-digit milliseconds, correctly, 120 times. Ask
      for the warm-up to treat a **3xx as not warm**, as well as for the locale to come from the
      config — a redirect that answers fast and carries no chunk should fail on the first attempt
      with the reason, not on the hundred-and-twentieth with a sentence about latency.
    - **The 8 specs** navigate to `/en-GB/...` and assert that URL back. **Excluding them would
      delete the suite rather than port it**, so they are left in place and reported.
      The last two are window 3's files and the sync replaces them, so a brand cannot fix them. **The
      REQUEST**: take the locale PREFIX from `src/i18n/routing.ts`, which already reads
      `SUPPORTED_LOCALES`, in the specs and in the warm-up path. Same shape as #441 parts 1 and 3 for
      the locale LIST and the address.

14. **The sharpest edge of 13, and the only part that stops the APP rather than the tests: no
    message catalogue.** `src/i18n/request.ts` spreads
    `(await import(...)).default` over the path `../../messages/<locale>.json` — **unguarded**;
    the try/catch beside it covers only window 6's optional `content` catalogue. The locale it
    resolves comes from `routing.locales`, i.e. `SUPPORTED_LOCALES`. So **a brand that correctly
    declares its own locale and ships no catalogue for it throws on every page**, in dev, in
    `next build` and in production alike. `messages/` holds only the starter's two.
    **And the one test for it was vacuous.** `test/i18n.test.ts` has
    `it('ships one per configured locale')`, which asserts the hard-coded set
    `['de-DE.json', 'en-GB.json']` and never reads the configured locales — in a brand app vitest
    sets no `SUPPORTED_LOCALES`, so `routing.locales` falls back to the starter's default and the
    brand's own locale is never mentioned. **It passed on a brand C that could not serve a page.**
    A test whose name describes an invariant it does not check is worse than no test: it answers the
    question you would otherwise have gone and looked at.
    The generator now writes `messages/<locale>.json` from the starter catalogue in the same
    language, or from its first locale marked **UNTRANSLATED** when there is none — because copying
    English into an `fr-FR` catalogue produces an app that renders, and an app that renders reports
    nothing. Brand C PRESERVES `test/i18n.test.ts` so it can expect three catalogues and read the
    locale out of `next.config.mjs`; that preservation comes out when window 3 fixes the starter's.

15. **A substitution table cannot read prose, and will turn true sentences false.** Rewriting
    `en-GB` to `en-US` everywhere produced two **false statements about the starter** in brand C's
    generated files: that the starter defaults `SUPPORTED_LOCALES` to `'en-US,de-DE'`, and that
    `seo-head.spec.ts` declares `['en-US', 'de-DE']`. Both were next to a file where the identical
    rewrite was correct.
    A locale literal is **data** in `lighthouserc.json` and **prose** everywhere else, and prose
    distinguishes "the locale this brand sells" (rewrite it) from "the locale the starter serves"
    (must not) — which a table cannot. The generator now computes pairs **per file** against
    `LOCALE_DATA_FILES`, and `localeProse()` reports the blocks a human has to write. The same is
    true of brand prose generally: "B is the first brand where the locale list is genuinely the
    brand's own" cannot be mechanically retargeted at C, and `brand B` -> `brand C` makes it a lie.

16. **A pure module's unit tests do not cover the CLI's adapter layer, and that is where the bug
    was.** `new-brand-plan.mjs` touches no filesystem so it can be tested directly — the right
    design, and it is why 45 tests were cheap. But `readTemplateMeta` in the CLI builds the template
    object by reading the template's files, and it had no `locales` field. **Every unit test passed**
    (the fixtures supplied one) and the real path threw `Cannot read properties of undefined`.
    The lesson is the same shape as #408's: verify the thing that will actually run. The catalogue
    writing in trap 14 was therefore proved by generating a throwaway `brand-d` with `fr-FR` and
    checking the file on disk, not by a fixture.

17. **A generated brand starts with a RED perf leg, and the generator cannot prevent it.**
    `README.md` is one of the four files `sync-from-starter.mjs` **excludes**, so a generated brand
    has no README — and `scripts/bundle-budget.mjs --verify` requires a
    `<!-- bundle-budget:start --> ... <!-- bundle-budget:end -->` block in it whose route list and
    budget column match `bundle-budget.json`. Without it: _"no block in README.md — run
    --sync-readme"_. The table can only be written by `--sync-readme` **after a completed
    `next build`**, which needs the shared machine. So writing the README is a manual step, and
    until someone builds the brand its perf leg is red for a reason that has nothing to do with its
    performance. (Brand B met the same gate from the other direction in #442: a **stale** block.)

18. **Where cross-brand tooling lives is load-bearing, because `apps/storefronts/*` means "a
    storefront".** `infra/ci/changes.sh` reduces every changed path under `apps/storefronts/` to its
    first two segments and reports any that is not a measurable storefront as `perf_unmeasured`;
    `.github/workflows/ci.yml` then does `exit 1` on a non-empty list. Putting the generator in
    `apps/storefronts/scripts/` therefore turned the **perf** job red with _"storefront changed with
    no perf script: apps/storefronts/scripts"_ and advice to add a `lighthouserc.json` to a
    directory that is not a storefront. It also sits outside the brands window's documented paths
    (`apps/storefronts/<brand>/**`).
    It now lives in `apps/storefronts/brand-b/scripts/` — the template brand, whose suite already
    holds its tests. A REQUEST proposes the real fix: let `changes.sh` ignore a directory with no
    `package.json` (it already computes `measurable` that way), or give cross-brand tooling a home
    outside `apps/storefronts/`.

19. **A brand already in the seed must NOT be sent to the onboarding wizard.** The generator's
    manual steps told brand C's author to create the store with `onboardStore` (#428) — but
    `brand-c`'s store, legal entity, tax rate, shipping countries and publishable key are **already
    in `packages/db`'s seed** (`SEED_IDS.*.brandC`; `packages/db/CLAUDE.md` says brand-a/b/c).
    Following the advice would have created a **second store for the same brand**. `SEEDED_BRANDS`
    now splits it: a seeded brand is told to CHECK the seeded store against the command line, and
    only a brand that is genuinely new goes to the wizard (section 6 below).

20. **The Prism mock is SINGLE-STORE, so a brand whose locale is not the contract example's
    cannot be rendered or e2e'd against the mock at all.** Measured on brand C, 2026-10-09:

    ```
    pk_brand-a_dev_…  ->  code=brand-a  locales=['en-GB', 'de-DE']
    pk_brand-b_dev_…  ->  code=brand-a  locales=['en-GB', 'de-DE']
    pk_brand-c_dev_…  ->  code=brand-a  locales=['en-GB', 'de-DE']
    ```

    Prism serves the contract's example store for **every** publishable key. And
    `src/lib/i18n.ts` has, correctly:

    ```ts
    export function assertStoreOffersLocale(store: Store | null, locale: string): void {
      if (store === null) return; // an outage is not a 404
      if (!store.locales.includes(locale)) notFound();
    }
    ```

    which runs in the **root `[locale]/layout.tsx`**, so it gates every localised route. Against the
    mock, brand C's `/en-US/...` therefore returns Next's own 404 — **correctly**. The app is
    fail-closed and the mock has one store; nothing is broken, and nothing can be rendered either.
    `/health` answers 200 throughout, which is how you tell this apart from a dead server.

    **This is the same accident as trap 13, a fifth time.** Brand B sells `en-GB`, which IS in the
    example store's locales, so B's mock render and B's mock e2e both worked and told us nothing.
    **Consequences for any brand on a new locale:** a mock render check is impossible; a mock e2e run
    is impossible even after #441 part 4 lands (the warm-up would start, and then every page would
    404); so **its e2e has to be a CORE leg**, against a backend that has the brand's real store.
    CI already runs brand legs that way. Plan for it rather than discovering it: #437 recorded a
    "mock render check" as a routine step, and for brand C that step does not exist.

    **It reaches CI through the PERF job, not the e2e one** — and I got this wrong first time, so the
    distinction is worth stating carefully:

    - **The live/e2e job is fine.** It runs `apps/*` on Prism but **brand storefronts on the kept core**
      (default since #295 — _"a brand that cannot reach the core fails here rather than quietly testing
      the mock"_), and the core holds the brand's real store.
    - **The perf job is not, and cannot be.** `scripts/perf.mjs` measures **always against the mock**, on
      purpose — _"always the mock, so runs are comparable"_, with `delete appEnv.STORE_API_URL`. So a
      brand whose locale the contract example does not offer measures 404s and its warm-up never
      succeeds: `#451: failed — not yet`, then a Lighthouse FAIL. The bundle budget passes, because it
      reads a build rather than a running server.

    So trap 20 is **not** a local-development-only finding, which is what I wrote after checking only the
    live job. It is a local finding **and** a red perf leg for every brand on a new locale.
    **RESOLVED by #448** (`0ec34d1`): `perf.mjs` validates a brand's `perf/store.example.json`
    against the spec's own `Store` schema and overlays it onto the mock's `GET /store` example, with
    the brand's Prism on `PERF_MOCK_PORT` 4012. **Both brand B and brand C now ship one** — B's too,
    even though B's measurement works by luck today, so no brand's perf depends on `en-GB` being in
    the shared contract example.

    Measured on brand C, 2026-10-09, with the file in place:

    ```
    ── Store mock for brand-c (perf/store.example.json) on http://127.0.0.1:4012 ──
    perf: warm-up http://127.0.0.1:3100/en-US/products #1: 227 ms
    perf: warm-up http://127.0.0.1:3100/en-US/products #2: 36 ms
    perf: warm-up http://127.0.0.1:3100/en-US/products/classic-tee #1: 83 ms
    perf: warm-up http://127.0.0.1:3100/en-US/products/classic-tee #2: 31 ms
    …
    Checking assertions against 2 URL(s), 10 total run(s)
    perf: bundle budget PASS, Lighthouse PASS
    ```

    **Two things to get right in that file, neither obvious:**

    - **Build it from the seed, not from the contract example.** Every field is a fact about the
      brand's real store: `SEED_IDS.stores.<brand>` for the id, `seedId(index, 6, 1)` for the sales
      channel, `code` for `content_space_id` and `<code>_products` for `search_index`. A plausible
      invention measures a store that does not exist.
    - **Copy the seeded THEME, not `{}`.** The seed gives each store a different `color.primary`
      (`#1E40AF`, `#047857`, `#B91C1C` by store index), and **Lighthouse scores accessibility on
      contrast** — so an empty theme measures the kit's default palette rather than the brand's, and
      the number would not be about this brand at all.

21. **A re-sync can add DEPENDENCIES, and `--frozen-lockfile` will not install them.** #448's
    `scripts/perf-store-example.mjs` imports `ajv`, `ajv-formats` and `yaml`. The sync copies the
    script and `merge-package-json.mjs` correctly merges the three new devDependencies into every
    brand's `package.json` — but the install had already run, so `node scripts/perf.mjs` died with
    `Cannot find module 'ajv'` from a file that had existed for thirty seconds. **Order matters:
    merge main, re-sync, THEN `pnpm install` without `--frozen-lockfile`** — frozen cannot add what
    the sync just introduced, and the error names the package rather than the cause. Trap 1 is the
    same lesson for a new workspace package; this is it for a new dependency of an existing one.

22. **Parameterising a spec's INPUT is not the same as parameterising its ASSERTIONS, and the
    second one is easy to forget.** #441 part 3 gave `completeAddressStep` an address from
    `E2E_SHIP_ADDRESS_JSON`, so brands B and C stopped timing out on "No delivery options are
    available for this address". They then failed **one** test each instead —
    `e2e/checkout.spec.ts` "what the customer agrees to", which did:

    ```ts
    await expect(page.getByText(/Keizersgracht 1/)).toBeVisible();
    ```

    The spec typed the brand's address and then asserted the **starter's** street on the review page.
    The fix (#449 → #450) is one line, `reviewAddressLine1(enteredAddress)`, but the shape is worth
    remembering: when a helper becomes configurable, grep the specs for the **old literal value**, not
    just for the helper. The address had three readers — the form filler, the review assertion, and
    the delivery-option precondition — and only the first was changed.

    Found by CI, not locally, and only once the warm-up fix let brand C's suite run at all: 44 passed
    / 6 skipped / **1 failed**, with brand B at 48 / 6 / 1 — the **same** inherited test. Two brands
    failing one identical test is the signature of an inherited literal rather than a brand defect.

23. **`git checkout -- scripts/sync-from-starter.mjs` silently un-does an un-preservation, and
    nothing fails.** Un-preserving a file is two edits that must agree: remove it from `PRESERVE` in
    the brand's own `sync-from-starter.mjs`, and let the next sync take the starter's copy. I did
    both for brand C's `test/i18n.test.ts`, then reverted an **unrelated** experiment with
    `git checkout -- apps/storefronts/brand-c/{vitest.config.ts,scripts/sync-from-starter.mjs}` —
    which restored the `PRESERVE` entry from HEAD along with it. I had already written a commit
    message saying the preservation was dropped.

    **Nothing caught it.** `sync --check` said "manifest is current" (truthfully — a preserved file
    is _allowed_ to differ), the file's content happened to match the starter's byte for byte, and
    every test passed. The only visible symptom was the sync's own count: **11 preserved for brand C
    where A and B had 10.** That one-line difference in a routine log is what a reader has to notice.

    Two things to take from it:

    - **A `git checkout --` with several paths is not a safe undo** when one of those paths carries
      an unrelated deliberate change. Revert the file you experimented with, not its neighbours.
    - **Compare the preserved COUNT across brands** after any sync work. `starter-preserved.json`
      is the record and the sync prints the number; a brand with one more preserved file than its
      siblings has either a good reason, written down, or a mistake. Brand C's good reason
      (`test/i18n.test.ts`, trap 14) stopped being good when #441 part 5 landed, and the count is
      what showed the removal had not actually happened.

24. **A `[[PLACEHOLDER]]` is not valid everywhere, and the document SET is easy to get wrong.**
    Two findings from the #444 review, which caught the generator writing **5** of brand B's **10**
    documents while its own comment said "the document SET mirrors; the prose does not" and § 1 above
    called the set fixed. Brand C therefore had no `about` page — and its `LAUNCH.md` 6.4 verified
    `/en-US/about` → 200 against a page that did not exist. A checklist row can be as wrong as code.

    - **The set is nav + footer + campaign + home + about + made + 4 legal.** Navigation and the
      footer are _mostly mechanical_, because the routes are the app's; only the labels are a
      decision. The campaign matters because the nav and footer link to it.
    - **Some fields reject placeholders, and only running the validator shows it.** The generated
      campaign failed `seed-content --dry-run` with _"endsAt — Must end after it starts"_: the schema
      compares the two dates, so `[[CAMPAIGN_STARTS_AT]]`/`[[CAMPAIGN_ENDS_AT]]` cannot stand. The
      dates have to be real **and live**, because `campaignIsLive()` gates the route and the nav
      links to it. Likewise `E2E_SHIP_ADDRESS_JSON` cannot hold one: `shippingAddressFromEnv`
      validates the country as two letters.
      **So "put a placeholder in it" is not a general strategy** — it works for prose and fails for
      anything another rule reads. Generate, then run the validator; do not reason about it.
    - **Brand C's content references no media slots**, unlike brand B's, because brand C's manifest
      declares none. `hero.image` is optional in the schema, so the documents validate without it.
      Pointing content at a slot that does not exist would be the same false record as inventing a
      `bytes` or `sha256` (§ 5).

## 4. What needed NOTHING, which is the good news

Two acceptance criteria were already satisfied by existing CI, and a generator should not try to wire
them:

- **The perf leg self-detects.** `infra/ci/changes.sh` builds `perf_apps` from every directory under
  `apps/storefronts/*` whose `package.json` has a `perf` script. Better: `perf_unmeasured` **fails**
  the perf check for a changed brand storefront that has _no_ `perf` script, so the gate cannot pass
  vacuously on a half-finished brand.
- **The e2e leg self-detects.** `infra/ci/run-e2e.sh` globs `apps/storefronts/*/playwright.config.*`
  and `E2E_INCLUDE_BRAND_STOREFRONTS` already defaults to on (#295).

#437's issue text said both needed wiring through a REQUEST. They did not. The REQUEST that **is**
needed is #439 — a `docker-bake.hcl` target and a `Dockerfile`, plus three lists (Terraform
`var.apps`, `deploy-staging.yml` `APPS`, Helm storefront values) that are **missing brand A as well**.

---

## 5. What is a draft, and must not be mistaken for finished

- **The brand name.** "Stonecrop" is an invented plant name chosen so it could not be read as a real
  company. The owner names the brand (`LAUNCH.md` 0.1).
- **All of B's prose** — home, about, made, campaign, footer. First-draft brand voice by window 10
  (`LAUNCH.md` 0.2). There are deliberately **no draft markers inside the rendered text**, on the
  manager's ruling: a visible "DRAFT" would be worse than a clean sentence that the checklist says is
  unapproved.
- **The four legal documents.** Structure and UK instruments are right; the wording is a developer's.
  17 `[[PLACEHOLDER]]`s (14 distinct) remain and `LAUNCH_GATE=1` fails until they are filled.
- **The media manifest.** It declares seven slots and deliberately carries **no `bytes`, `sha256`,
  `width` or `height`: brand B's stills have not been generated**, and a made-up size or digest would
  be a false record. `resolve-media.mjs` does not read those fields; only brand A's media test
  asserts them. The manifest's own `source` and `generator` say `NOT YET GENERATED`.

**A new brand cannot have a faithful media manifest before its media exists.** A generator should
write the slot list and leave the digests absent, exactly as this one does.

---

## 6. A brand that is NOT already in the seed

Everything above assumed brand B's store existed. A genuinely new brand also needs, before the app is
worth running:

1. **A store in the core.** Since 2026-10-08 this is `onboardStore` (Admin API 0.4.12) rather than a
   seed edit — store, code, currency, locales, country, timezone, tax rate, shipping countries.
2. **A legal entity** and its VAT registration.
3. **A publishable key**, created with the store. The seeded `pk_<brand>_dev_…` keys exist only for
   local databases, and `infra/helm/check-values.sh` rejects a `_dev_` key in staging values.
4. **A Keycloak client** in the customers realm, with the `store_code` claim and the brand's redirect
   URIs. `infra/keycloak/customers-realm.json` is window 5's; realms import on first start only, so
   it needs `node infra/keycloak/reimport.mjs customers`.
5. **A Sanity dataset** declared in `cms/src/datasets.ts` — window 6's file, and
   `test/datasets.test.ts` fails if it drifts from the seed's store list.
6. **Products.** The seed generates 200 per store procedurally; a real brand has a catalogue.

Of these, only (5) is a `CONTRACT CHANGE:`/`REQUEST:` from window 10's side. (1)–(4) are an operator
flow now, which is what #428's onboarding wizard is for — so **#438's script should stop at the app
and the content, and point at the wizard for the store.** Automating a store create from a brands
window would duplicate it and bypass its permission checks.
