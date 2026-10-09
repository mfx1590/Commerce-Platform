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

9. **Two inherited e2e specs hard-code the starter's two locales, and excluding them costs real
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
