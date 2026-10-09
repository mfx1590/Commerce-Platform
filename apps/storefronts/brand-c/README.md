# @platform/storefront-brand-c

Brand C's storefront: **US market, USD, `en-US` only**, dev port **3103**.

The brand has **no name yet**. "Brand C" is the string the generator was given on the command line;
`LAUNCH.md` 0.1 is the owner action that replaces it. Nothing is derived from it, so changing it is
one line in `src/brand/config.ts` plus the strings in `cms/brand-c/content/*.json`.

**C is the first brand created by a script** —
`node apps/storefronts/brand-b/scripts/new-brand.mjs brand-c --name "Brand C" --currency usd
--locale en-US --port 3103 --jurisdiction us` — and the first brand whose locale is **not one the
starter serves**. Both facts shape this README.

## Identity

| Thing           | Value                                                         |
| --------------- | ------------------------------------------------------------- |
| Store code      | `brand-c`                                                     |
| Currency        | **USD**, quoted **without** sales tax (NY 8.875% at checkout) |
| Locales         | **`en-US` only**                                              |
| Ships to        | **US only** (`shippingCountries: ['US']`)                     |
| Legal entity    | `Brand C Inc.`, US, `America/New_York`                        |
| Dev port        | **3103**                                                      |
| Publishable key | `pk_brand-c_dev_…` — the seed's dev key, local databases only |
| Keycloak client | `storefront-brand-c`                                          |
| Sanity dataset  | `brand-c`                                                     |

All of it except the port and the package name **already existed in `packages/db`'s seed**
(`SEED_IDS.*.brandC`). #438 generated the app, not the store. If you generate another brand, check
the command line against the seeded store rather than assuming — an app and a store that disagree
about currency or locale is a silent bug, and the generator now says so in its manual steps.

## Run

```bash
pnpm mock                                             # Prism Store API on :4010
pnpm --filter @platform/storefront-brand-c dev        # brand C on :3103
pnpm --filter @platform/storefront-brand-c build
pnpm --filter @platform/storefront-brand-c start
```

## Test

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test --filter @platform/storefront-brand-c       # 583 passed, 3 skipped
LAUNCH_GATE=1 pnpm test --filter @platform/storefront-brand-c   # FAILS: 23 placeholders left
node cms/brand-c/scripts/seed-content.mjs --dry-run   # 5 documents valid (1 page, 4 legal)
node scripts/sync-from-starter.mjs --check            # manifest is current
```

**`pnpm e2e` cannot be believed yet** — see "The locale gap" below. It is not that a test fails; the
harness does not start.

## Diff against the starter

`208 copied, 1 merged, 11 preserved, 4 excluded` from 224 tracked starter files. The eleven preserved
files are the ten every brand preserves — `next.config.mjs`, `playwright.config.ts`,
`lighthouserc.json`, `scripts/start.mjs`, `tailwind.config.ts`, `tsconfig.json` and the four under
`src/brand/` — plus one that is brand C's alone:

### `test/i18n.test.ts` is preserved, and no other brand does that

The starter's version has `it('ships one per configured locale')`, which asserts the hard-coded set
`['de-DE.json', 'en-GB.json']` and **never reads the configured locales**. In a brand app vitest sets
no `SUPPORTED_LOCALES`, so `routing.locales` falls back to the starter's default and the brand's own
locale is never mentioned — the test passed on a brand C that could not serve a single page.

C's copy expects three catalogues and adds a test that reads `SUPPORTED_LOCALES` out of
`next.config.mjs`, which is where a brand really declares it, and fails if a catalogue is missing.
The preservation is a stopgap: a REQUEST asks window 3 to derive the expected set from the config,
after which this file re-syncs normally.

### Two deliberate divergences inherited from brands A and B, both load-bearing

- **`lighthouserc.json` keeps `numberOfRuns: 5`**, not the starter's 3 (#348), and the 2500 ms LCP
  budget. Its two `collect.url` entries point at **`/en-US`** — the generator used to copy this file
  byte for byte, which left brand C measuring two `/en-GB` 404s and reporting the result as a
  performance score.
- **`playwright.config.ts` does not import `RUNTIME_SITE_URL`** (#379) and sets
  `STORE_PUBLISHABLE_KEY` itself (#382).

## The locale gap

Brand C sells `en-US`. The starter serves `en-GB` and `de-DE`, and writes those into its synced files
as literals. **Brand B sells `en-GB`, one of the starter's two, so every literal B inherited happened
to be right and cloning B told us nothing.** For brand C none of them are right: 8 synced spec files,
43 occurrences, plus the e2e warm-up path and the lighthouse URLs.

What is fixed here, in brand C's own files:

- **`messages/en-US.json` exists.** This is the one that stops the app rather than the tests:
  `src/i18n/request.ts` does `import(\`../../messages/${locale}.json\`)`**unguarded** — the
try/catch beside it covers only the optional CMS catalogue — so without this file brand C throws on
**every page**, in dev, in`next build`and in production alike. It is the starter's`en-GB.json`
with two strings Americanised ("was not authorised" → "authorized"); 139 keys, same key set. It has
had **no US-English review** (`LAUNCH.md` 12.2).
- **`SUPPORTED_LOCALES=en-US`** is a runtime default in `next.config.mjs`, because
  `src/i18n/routing.ts` is synced. Do not edit `routing.ts`.
- **`lighthouserc.json`** measures `/en-US`.

What is **not** fixed, because it is window 3's and the sync replaces it:

- **Every synced e2e spec** navigates to `/en-GB/…` and asserts that URL back.
- **`scripts/e2e-server.mjs`** warms `/en-GB` before declaring the app ready, and its `timed()`
  returns null for any status ≥ 400 — so the warm-up never succeeds and it throws after 120 s. e2e
  fails **before the first test**, not as a failing test. _Read from the code; not yet run._

Excluding those specs would delete the suite rather than port it, so they are left in place and
reported. A REQUEST asks window 3 to take the locale prefix from `src/i18n/routing.ts`, which already
reads `SUPPORTED_LOCALES` — the same shape as #441 parts 1 and 3 for the locale list and the address.

## Media

`cms/brand-c/media/manifest.json` has **no slots and no digests**: brand C's stills do not exist. A
made-up `bytes` or `sha256` would be a false record the resolver would later contradict, so the
generator refuses to invent them. `LAUNCH.md` § 7.

## Bundle budget

First-load JS per route, gzipped, against `bundle-budget.json`. Regenerate with
`node scripts/bundle-budget.mjs --sync-readme` after a build — the table below is written by that
command, so do not edit it by hand. **`scripts/perf.mjs` exits 1 if this block is missing or stale.**

<!-- bundle-budget:start -->

**Not measured yet.** This table is written by `node scripts/bundle-budget.mjs --sync-readme`, which
needs a completed `next build`, and brand C has not been built on the shared machine yet (one window
measures at a time). Until it is run, `scripts/bundle-budget.mjs --verify` fails with _"README.md
lists different routes or budgets"_ and brand C's perf leg is red for that reason.

This is a gap the generator cannot close: `README.md` is one of the four files the sync **excludes**,
so a generated brand has no README at all and therefore no block — which means **every brand created
by script starts with a red perf leg** until someone builds it and runs `--sync-readme`. Recorded in
`ONBOARDING-GAPS.md`.

<!-- bundle-budget:end -->

## Performance

`lighthouserc.json`: **5 runs per URL, LCP asserted at 2500 ms** — the same budget as brands A and B.
`numberOfRuns: 5` rather than the starter's 3 for the reason #348 measured: the asserted value is the
best of N, and N=3 was too few for the run-to-run spread. **Do not loosen either number**; raise N
before touching the budget, and argue a threshold from the worst observed run, never the median.

The perf gate picks this app up **automatically** — `infra/ci/changes.sh` measures every
`apps/storefronts/*` with a `perf` script, and fails the check for a changed brand storefront that
has none. Verified for brand C: `perf_apps` lists it and `perf_unmeasured` is `[]`.

That same rule is why the generator does **not** live in `apps/storefronts/scripts/`: every changed
path under `apps/storefronts/` is reduced to a storefront directory, so a tools directory there is
reported as an unmeasurable storefront and the perf job exits 1. It lives in
`apps/storefronts/brand-b/scripts/` instead.

## Not here

The Dockerfile and the `docker-bake.hcl` target (window 5's — REQUEST #439), and the **`COPY` line
for brand C's `package.json` in nine existing Dockerfiles**, without which `app images` is red; the
product catalogue (the `packages/db` seed); brand C's imagery (not generated); and the brand's name.

`apps/storefronts/brand-b/ONBOARDING-GAPS.md` is the full list of what onboarding a brand still needs
from a developer. Brand C is the evidence for most of it — it was generated to find out what the
generator could not do, and it found more than expected.
