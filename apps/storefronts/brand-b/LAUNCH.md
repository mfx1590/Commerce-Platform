# Brand B (Stonecrop) — launch checklist

Derived from `apps/storefronts/brand-a/LAUNCH.md` (#144) with brand B's values, as part of #437.
Brand A's version is the reference for anything described only once here.

**What is different about B, in one place.** B is **GBP / `en-GB` only**, ships to **GB only**, VAT
**20%**, legal entity **GB**, dev port **3102**, publishable key `pk_brand-b_dev_…` (local databases
only), Keycloak client `storefront-brand-b`, Sanity dataset `brand-b`. Its store, legal entity,
products and key **already exist in the seed** — #437 cloned the app, not the store.

**Status key:** ✅ done · ❌ not done, no blocker · ⛔ blocked on an owner action or on an environment
that does not exist yet.

**`Owner` column:** `owner` = the business owner · `5` = window 5 (infra) · `10` = window 10 (brands)
· `3` = window 3 (starter).

---

## 0. Brand identity

| #   | Item                                                               | Owner | Verify                                                      | Now |
| --- | ------------------------------------------------------------------ | ----- | ----------------------------------------------------------- | --- |
| 0.1 | **The brand's real name is chosen.** "Stonecrop" is a WORKING name | owner | `src/brand/config.ts` `brandConfig.name` is the agreed name | ⛔  |
| 0.2 | **Brand copy reviewed by the brand owner**                         | owner | the owner signs off `cms/brand-b/content/*.json` prose      | ⛔  |
| 0.3 | Wordmark / logo asset exists and is in the media manifest          | owner | `og-default` resolves to a real file                        | ⛔  |

0.1 and 0.2 are the two rows that did not exist for brand A, and they exist because **the name and
the prose in this app are a first draft written by window 10, not approved copy.** Changing the name
is one line in `src/brand/config.ts` plus the strings in `cms/brand-b/content/*.json`; nothing is
generated from it. See `ONBOARDING-GAPS.md` § "What is a draft".

---

## 1. Domain, DNS and certificates

| #   | Item                                                          | Owner  | Verify                                                       | Now |
| --- | ------------------------------------------------------------- | ------ | ------------------------------------------------------------ | --- |
| 1.1 | Brand B's production hostname chosen and registered           | owner  | `nslookup <host>` returns the ALB                            | ⛔  |
| 1.2 | Hosted zone record for brand B's host                         | 5      | `aws route53 list-resource-record-sets …` shows the host     | ❌  |
| 1.3 | TLS certificate on the ALB; HTTP → HTTPS                      | 5      | `curl -sI https://<host>/health` → `200`                     | ❌  |
| 1.4 | `SITE_URL` equals the public origin (fails closed without it) | 5 / 10 | `bash infra/helm/check.sh`                                   | ❌  |
| 1.5 | Canonicals, sitemap and redirects use that origin             | 10     | `curl -s https://<host>/sitemap.xml \| grep -c '<loc>https'` | ⛔  |

The seed's domain is `shop.brand-b.local`, which is a local name only.

---

## 2. Environment and secrets

Brand B reads at runtime: `STORE_API_URL`, `STORE_PUBLISHABLE_KEY`, `SITE_URL`,
`SUPPORTED_LOCALES`, `DEFAULT_LOCALE`, `KEYCLOAK_*` (customer sign-in), `SANITY_PROJECT_ID` /
`CMS_DATASET`, `ROBOTS_ALLOW_INDEXING`. No Stripe, Cloudinary or analytics secret reaches it.

| #   | Item                                                                     | Owner | Verify                                             | Now |
| --- | ------------------------------------------------------------------------ | ----- | -------------------------------------------------- | --- |
| 2.1 | A **production** publishable key exists; the `_dev_` key is not deployed | owner | `infra/helm/check-values.sh` rejects a `_dev_` key | ⛔  |
| 2.2 | `SUPPORTED_LOCALES=en-GB` in the deployed environment                    | 5     | the running app routes `/en-GB` and not `/de-DE`   | ✅  |
| 2.3 | `CMS_DATASET=brand-b`                                                    | 5     | content routes render brand B's documents          | ⛔  |
| 2.4 | Brand B is in the deploy matrix, the ECR list and the Helm values        | 5     | REQUEST #439                                       | ❌  |

2.2 is ✅ **in this app** — `next.config.mjs` defaults it, so a deployment that forgets the variable
still serves one locale. It is listed because the deployed value should be explicit, not inherited.

---

## 3. Keycloak customers client

| #   | Item                                               | Owner | Verify                                                  | Now |
| --- | -------------------------------------------------- | ----- | ------------------------------------------------------- | --- |
| 3.1 | `storefront-brand-b` exists in the customers realm | 5     | the client is in `infra/keycloak/customers-realm.json`  | ✅  |
| 3.2 | Its redirect URIs include the production origin    | 5     | sign-in returns to `https://<host>/…`, not to localhost | ❌  |
| 3.3 | `store_code` claim is `brand-b`                    | 5     | a minted customer token carries it                      | ✅  |

---

## 4. Payments

| #   | Item                                                 | Owner | Verify                                               | Now |
| --- | ---------------------------------------------------- | ----- | ---------------------------------------------------- | --- |
| 4.1 | Stripe account and **live** keys for brand B's store | owner | `GET /store` lists `card` in `payment.methods`       | ⛔  |
| 4.2 | Invoice (`manual`) allowed or refused, deliberately  | owner | `settings.payment.invoice_allowed` is set on purpose | ⛔  |

Card data never reaches this app: the Payment Element is hosted fields.

---

## 5. Search index

| #   | Item                                        | Owner | Verify                                  | Now |
| --- | ------------------------------------------- | ----- | --------------------------------------- | --- |
| 5.1 | An index exists for `brand-b` and is filled | 9     | shopper search returns brand B products | ⛔  |

Shopper search is a database `ILIKE` today for every brand.

---

## 6. CMS dataset

| #   | Item                                               | Owner | Verify                                              | Now |
| --- | -------------------------------------------------- | ----- | --------------------------------------------------- | --- |
| 6.1 | `brand-b` dataset declared                         | 6     | `cms/src/datasets.ts`                               | ✅  |
| 6.2 | A Sanity project exists and the dataset is created | owner | `SANITY_PROJECT_ID` is set and the dataset resolves | ⛔  |
| 6.3 | B's 10 documents seeded into it                    | 10    | `node cms/brand-b/scripts/seed-content.mjs`         | ⛔  |
| 6.4 | Content routes render against a real dataset       | 10    | `/en-GB/about`, `/en-GB/made`, `/en-GB/legal/*` 200 | ⛔  |

6.4 has **never been run for any brand** — there is no Sanity project locally, so content routes are
only unit-tested. Brand A carries the same gap.

---

## 7. Imagery

| #   | Item                                               | Owner | Verify                                           | Now |
| --- | -------------------------------------------------- | ----- | ------------------------------------------------ | --- |
| 7.1 | **Brand B's stills are generated**                 | owner | `cms/brand-b/media/manifest.json` has real files | ⛔  |
| 7.2 | A Cloudinary account on a paid plan                | owner | `CLOUDINARY_CLOUD_NAME_BRAND_B` resolves         | ⛔  |
| 7.3 | The manifest records bytes + sha256 for every slot | 10    | the media test asserts them, as brand A's does   | ⛔  |

7.1 and 7.3 are the honest state: **B's manifest declares its seven slots but carries no `bytes`,
`sha256`, `width` or `height`, because the files do not exist.** Inventing them would be a false
record. See `ONBOARDING-GAPS.md`.

---

## 8. Analytics and consent

| #   | Item                                                    | Owner | Verify                                | Now |
| --- | ------------------------------------------------------- | ----- | ------------------------------------- | --- |
| 8.1 | A consent decision for `sf_attribution` (30-day cookie) | owner | a banner exists, or a recorded ruling | ⛔  |

Same unresolved item as brand A's 8.1, and the UK rules (PECR) are not identical to the EU's.

---

## 9. Legal pages

| #   | Item                                                   | Owner | Verify                                             | Now |
| --- | ------------------------------------------------------ | ----- | -------------------------------------------------- | --- |
| 9.1 | The four documents exist in `en-GB`                    | 10    | `cms/brand-b/content/legal.json`                   | ✅  |
| 9.2 | **The 17 `[[PLACEHOLDER]]`s are filled** (14 distinct) | owner | `LAUNCH_GATE=1 pnpm test --filter …brand-b` passes | ⛔  |
| 9.3 | A solicitor has reviewed all four for **UK** law       | owner | written sign-off                                   | ⛔  |
| 9.4 | The placeholder gate is wired into the go-live run     | 10    | the command in 9.2 is in the release checklist     | ✅  |

B's texts cite **UK** instruments — Consumer Rights Act 2015, Consumer Contracts Regulations 2013,
UK GDPR / Data Protection Act 2018, ICO — not the German statutes brand A's imprint carries. They are
still **drafts written by a developer** and 9.3 is the gate that matters.

---

## 10. Monitoring and alerts

| #    | Item                                        | Owner | Verify                            | Now |
| ---- | ------------------------------------------- | ----- | --------------------------------- | --- |
| 10.1 | Error tracking in the storefront            | 5     | an error appears in the tracker   | ❌  |
| 10.2 | `/health` reports this app, not the starter | 3     | `curl -s /health` names `brand-b` | ❌  |
| 10.3 | Alert rules for the brand's hostname        | 5     | a rule exists                     | ❌  |
| 10.4 | Google Rich Results test on a real URL      | 10    | the test passes                   | ⛔  |

10.2 is brand A's open item too: `/health` answers `"app":"storefront-starter"` for every clone.

---

## 11. Release and rollback

| #    | Item                                                   | Owner | Verify                                          | Now |
| ---- | ------------------------------------------------------ | ----- | ----------------------------------------------- | --- |
| 11.1 | A Dockerfile and a bake target for brand B             | 5     | REQUEST #439                                    | ❌  |
| 11.2 | The perf leg measures brand B                          | 10    | `perf_apps` includes `apps/storefronts/brand-b` | ✅  |
| 11.3 | Brand B's e2e journey runs in CI                       | 10/5  | `run-e2e.sh` globs it (automatic)               | ✅  |
| 11.4 | A rollback procedure that names the previous image tag | 5     | the runbook                                     | ❌  |

11.2 and 11.3 were ✅ **without any infra change** — both legs self-detect a new storefront. See
`ONBOARDING-GAPS.md`, which is the useful half of that finding.

---

## Dry run

**Against staging: not possible.** No deployed environment exists for any brand (the same finding as
brand A's #144, still open; #342 tracks the AWS account).

**On a laptop, 2026-10-09**, main `bc5bac9`, no docker:

| Check                                                           | Result |
| --------------------------------------------------------------- | ------ |
| `pnpm lint`, `pnpm format:check`                                | pass   |
| `pnpm typecheck --filter @platform/storefront-brand-b`          | pass   |
| `pnpm test --filter @platform/storefront-brand-b`               | pass   |
| `pnpm test --filter @platform/storefront-brand-a` (unchanged)   | pass   |
| B's 10 documents resolve and validate against the shared schema | pass   |
| `LAUNCH_GATE=1` fails on B's 17 placeholders, naming each       | pass   |
| `perf_apps` lists brand B                                       | pass   |

The build, the mock render check and the one core e2e run are recorded in #437's PR body — the
machine is shared and one window measures at a time.

---

## Owner actions, in launch order

1. **Name the brand** (0.1). "Stonecrop" is a developer's working name.
2. **Read the copy** (0.2) and the four legal drafts (9.3). None of it is approved.
3. Choose and register the hostname (1.1).
4. The AWS account, so an environment exists at all (#342) — blocks §1, §10, §11 and the dry run.
5. Generate brand B's imagery (7.1) and open the Cloudinary account (7.2).
6. The Sanity project (6.2), so content routes can be run even once (6.4).
7. Fill the 17 legal placeholders (9.2) and get UK sign-off (9.3).
8. Stripe for brand B (4.1) and the invoice decision (4.2).
9. The consent decision (8.1), under UK PECR as well as GDPR.
