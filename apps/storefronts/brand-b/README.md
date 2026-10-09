# @platform/storefront-brand-b — Stonecrop

Brand B's storefront. **GB market, GBP, `en-GB` only.** Generated from `apps/storefront-starter` per
ADR 0004 and kept in step with it by `scripts/sync-from-starter.mjs`.

> **"Stonecrop" is a working name.** The brand name, all of the prose in `cms/brand-b/content`, and
> the four legal documents are a **developer's first draft**, not approved copy. `LAUNCH.md` rows 0.1
> and 0.2 are the owner's sign-off, and `ONBOARDING-GAPS.md` § 5 lists exactly what is draft.

## Identity

|                   |                                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| Port              | **3102** (`scripts/start.mjs`, `playwright.config.ts`, `package.json` `dev`)      |
| Currency / locale | **GBP**, **`en-GB` only**                                                         |
| Store code        | `brand-b` (already in the `packages/db` seed, with its legal entity and products) |
| Publishable key   | `pk_brand-b_dev_…` — the seeded **dev** key, local databases only                 |
| Keycloak client   | `storefront-brand-b` (customers realm)                                            |
| Sanity dataset    | `brand-b` (`cms/src/datasets.ts`)                                                 |
| Content           | `cms/brand-b/` — 10 documents, en-GB                                              |

## Run

```bash
pnpm mock                                          # Prism Store API on :4010
pnpm --filter @platform/storefront-brand-b dev      # brand B on :3102
```

Against the real core: `STORE_API_URL=http://localhost:9000`, with the core running
`CORE_STORE_API_FALLBACK=1` and `CORE_STORE_API_FALLBACK_URL=http://localhost:4010`.

## Test

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test --filter @platform/storefront-brand-b
```

**The launch gate is separate and not part of CI:**

```bash
LAUNCH_GATE=1 pnpm test --filter @platform/storefront-brand-b
```

It **fails today**, listing the 17 `[[PLACEHOLDER]]`s (14 distinct) still in
`cms/brand-b/content`. That is correct: it is a go-live check, not a build check, and a test that was
red for weeks would be disabled. It scans **all** of `content/*.json`, not only the imprint — which
is how it caught `[[COMPANY_LEGAL_NAME]]` in the footer's copyright line. It belongs in the release
checklist (`LAUNCH.md` 9.4).

## Diff against the starter

Everything outside this table is byte-identical to `apps/storefront-starter` and is refreshed with
`pnpm --filter @platform/storefront-brand-b sync`. `sync --check` reports drift in the **preserved**
files, which the sync never overwrites.

| File                                                                        | What differs                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `package.json`                                                              | name, dev port 3102 (merged, not preserved — starter additions still arrive) |
| `next.config.mjs`                                                           | B's publishable key, and **`SUPPORTED_LOCALES=en-GB`**                       |
| `src/brand/config.ts`                                                       | `name` and `description` only — the rest is the starter's `siteUrl()`        |
| `src/brand/tokens.ts`                                                       | B's palette, system font stack, squarer radii                                |
| `playwright.config.ts`                                                      | port 3102, path depth, `STORE_PUBLISHABLE_KEY ??=`, platform-keyed snapshots |
| `lighthouserc.json`                                                         | `numberOfRuns: 5` (#348) — the starter is still 3                            |
| `tsconfig.json`, `tailwind.config.ts`                                       | one extra `../` (a brand is one level deeper)                                |
| `scripts/start.mjs`                                                         | default port 3102                                                            |
| `test/launch-gate.test.ts`, `e2e/journey.spec.ts`                           | brand B's own, not in the starter                                            |
| `LAUNCH.md`, `ONBOARDING-GAPS.md`, `README.md`, `CHANGELOG.md`, `CLAUDE.md` | this app's own                                                               |

### Two deliberate divergences, both load-bearing

- **`LOCAL_DEVELOPMENT_SITE_URL` stays `http://localhost:3100`** even though this app runs on 3102.
  It is the **starter's** constant and synced starter tests assert it; brand A left it alone for the
  same reason. Changing it breaks six tests the next sync would restore anyway.
- **`playwright.config.ts` does not import `RUNTIME_SITE_URL`** from `e2e/support/build-origin`,
  however the starter writes it. That module reads `process.env.SITE_URL` in a module-level `const`,
  and ES imports evaluate before the importing module's body — so the import would freeze the
  starter's `:3100` before this app ever set its own port, and every redirect would leave the brand
  (#379). The local `SITE_URL` is the same string computed after the assignment.

## One locale, and why it is set where it is

`src/i18n/routing.ts` is **synced** and defaults `SUPPORTED_LOCALES` to `'en-GB,de-DE'` — the
starter's two. Brand A happens to sell exactly those, so it never had to intervene. Brand B sells one,
and says so with a runtime default in `next.config.mjs`, which `next build`, `next dev` and
`next start` all load before any app code. Editing `routing.ts` would be drift the next sync undoes.

**`e2e/journey.spec.ts` tests it**, because a brand that quietly kept both locales would serve a
German URL space with no German content.

Note that **unit tests do not see that setting** — vitest does not load `next.config.mjs`, so the
unit suite still exercises the starter's two-locale default. `ONBOARDING-GAPS.md` § 3.8 has the clean
fix, which belongs in the starter.

## Media

`cms/brand-b/media/manifest.json` declares seven slots. It deliberately carries **no `bytes`,
`sha256`, `width` or `height`: brand B's stills have not been generated yet**, and a made-up size or
digest would be a false record. `scripts/resolve-media.mjs` does not read those fields — only brand
A's media test asserts them. The manifest's own `source` and `generator` say `NOT YET GENERATED`.

Slots resolve to Cloudinary delivery URLs at **seed time**; with no cloud name set, optional images
are left out and the documents stay valid.

## Bundle budget

First-load JS per route, gzipped, against `bundle-budget.json`. Regenerate with
`node scripts/bundle-budget.mjs --sync-readme` after a build — the table below is written by that
command, so do not edit it by hand. **`scripts/perf.mjs` exits 1 if this block is missing or stale**,
which is how brand B's first perf leg went red (#442) even though every route was within budget.

<!-- bundle-budget:start -->

| Route                                         | First load (gzipped) | Budget             |
| --------------------------------------------- | -------------------- | ------------------ |
| `/[locale]/(account)/account/orders/page`     | 130.5 kB             | 145 kB _(default)_ |
| `/[locale]/(account)/account/page`            | 133 kB               | 145 kB _(default)_ |
| `/[locale]/(checkout)/cart/page`              | 139.7 kB             | 145 kB             |
| `/[locale]/(checkout)/checkout/address/page`  | 133.7 kB             | 139 kB             |
| `/[locale]/(checkout)/checkout/page`          | 129.3 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/checkout/payment/page`  | 133.7 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/checkout/review/page`   | 134.7 kB             | 139 kB             |
| `/[locale]/(checkout)/checkout/shipping/page` | 133.7 kB             | 145 kB _(default)_ |
| `/[locale]/(checkout)/orders/[orderId]/page`  | 130.5 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/campaign/[slug]/page`    | 132.8 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/legal/[slug]/page`       | 132.8 kB             | 145 kB _(default)_ |
| `/[locale]/(content)/pages/[slug]/page`       | 132.8 kB             | 145 kB _(default)_ |
| `/[locale]/(shop)/categories/[handle]/page`   | 136.2 kB             | 141 kB             |
| `/[locale]/(shop)/page`                       | 131.1 kB             | 136 kB             |
| `/[locale]/(shop)/products/[handle]/page`     | 139.2 kB             | 144 kB             |
| `/[locale]/(shop)/products/page`              | 136.2 kB             | 141 kB             |
| `/_not-found/page`                            | 102.9 kB             | 145 kB _(default)_ |

_Generated by `pnpm --filter @platform/storefront-starter bundle-budget --sync-readme`; budgets live in `bundle-budget.json`._
<!-- bundle-budget:end -->

## Performance

`lighthouserc.json`: **5 runs per URL, LCP asserted at 2500 ms** — the same budget as brand A, and
`numberOfRuns: 5` rather than the starter's 3 for the reason #348 measured (the asserted value is the
best of N, and N=3 was too few for the run-to-run spread). **Do not loosen either number**; raise N
before touching the budget, and argue a threshold from the worst observed run, never the median.

The perf gate picks this app up **automatically** — `infra/ci/changes.sh` measures every
`apps/storefronts/*` with a `perf` script, and fails the check for a changed brand storefront that
has none.

## Not here

The Dockerfile and the `docker-bake.hcl` target (window 5's — REQUEST #439), the product catalogue
(the `packages/db` seed), and brand B's imagery (not generated). `ONBOARDING-GAPS.md` is the full
list of what onboarding a brand still needs from a developer, and the input to #438.
