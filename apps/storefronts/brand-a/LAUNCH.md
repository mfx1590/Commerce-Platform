# Brand A — launch checklist

Task 2.6 (#144). Everything that has to be true before brand A (Fieldnote, store `brand-a`, EU/EUR,
en-GB + de-DE) takes real orders. Each item names the window that owns it and the command or URL that
**verifies** it, so checking an item means running something, not taking someone's word.

**Status on 2026-10-05: not launchable, and not yet deployable.** Brand A is built, tested and
green on a laptop. **No deployed environment exists**, staging included. `infra/README.md` says
nothing has been run against a real AWS account, and `deploy-staging.yml` exits as a no-op until
its AWS/ArgoCD settings exist. Even then it deploys `core admin storefront-starter`, not brand A.
The staging dry run #144 asks for therefore **could not be run**. The laptop dry run below covers
every item that can be checked without a deployment, and its results are recorded.

Windows: **1** core · **2** auth · **3** storefront starter · **5** infra/CI · **6** CMS ·
**7** payments · **9** search · **10** brands (this app) · **12** data · **owner** = the business
owner (accounts, credentials, legal sign-off).

Columns: **Verify** is what proves the item. **Now** is the result on 2026-10-05. ✅ passed on a
laptop · ⛔ blocked, needs a deployment or an owner action · ❌ missing, has to be built first.

---

## 1. Domain, DNS and certificates

| #   | Item                                                                | Owner  | Verify                                                                                    | Now |
| --- | ------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- | --- |
| 1.1 | Brand A's production hostname chosen and registered                 | owner  | `nslookup <host>` returns the ALB                                                         | ⛔  |
| 1.2 | Route 53 hosted zone for the base domain; record for brand A's host | 5      | `aws route53 list-resource-record-sets --hosted-zone-id <id>` shows the host              | ❌  |
| 1.3 | TLS certificate (ACM) on the ALB; HTTPS listener; HTTP → HTTPS      | 5      | `curl -sI https://<host>/health` → `200`; `curl -sI http://<host>/` → `301` to `https://` | ❌  |
| 1.4 | `SITE_URL` equals the public origin (fails closed without it, #320) | 5 / 10 | `bash infra/helm/check.sh` (enforces `SITE_URL == https://<ingress.host>`)                | ✅  |
| 1.5 | Canonicals, sitemap and redirects use that origin                   | 10     | `curl -s https://<host>/sitemap.xml \| grep -c '<loc>https://<host>/'` > 0                | ⛔  |

Today the Helm values hold only placeholder hosts (`shop.<env>.example.com`), and there is no TLS
block on the ingress and no prod values file.

## 2. Environment and secrets

Brand A reads exactly these at runtime (no Stripe, Cloudinary or analytics key reaches the
storefront):

| Variable                                                              | Value in production                                                           | Secret?               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------- |
| `STORE_API_URL`                                                       | the core's internal URL                                                       | no                    |
| `STORE_PUBLISHABLE_KEY`                                               | brand A's **production** publishable key (not the `pk_brand-a_dev_…` default) | no (public by design) |
| `SITE_URL`                                                            | `https://<host>`, required: a production server without it answers 500        | no                    |
| `ROBOTS_ALLOW_INDEXING`                                               | `1` in production **only**                                                    | no                    |
| `PORT`                                                                | 3101 (the image's default)                                                    | no                    |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM_CUSTOMERS`, `KEYCLOAK_CLIENT_ID`      | the production realm; client `storefront-brand-a`                             | no                    |
| `SANITY_PROJECT_ID`, `SANITY_API_VERSION`                             | the platform's Sanity project                                                 | no                    |
| `SANITY_READ_TOKEN`, `SANITY_PREVIEW_SECRET`, `SANITY_WEBHOOK_SECRET` | per environment                                                               | **yes**               |

| #   | Item                                                                                     | Owner | Verify                                                                                            | Now |
| --- | ---------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- | --- |
| 2.1 | Secrets in AWS Secrets Manager, projected by External Secrets, read with `envFrom`       | 5     | `kubectl -n <ns> get externalsecret,secret` shows `Ready`; `kubectl exec … -- printenv SITE_URL`  | ⛔  |
| 2.2 | No secret in the image or the repo                                                       | 5     | CI `secret scan (gitleaks)` green on the release commit                                           | ✅  |
| 2.3 | Production publishable key issued for store `brand-a` (the dev key is seeded and public) | 1     | `curl -s -H 'x-publishable-key: <pk>' https://<core>/store` → `"code":"brand-a"`                  | ⛔  |
| 2.4 | Brand A has its own Helm values, ArgoCD Application and ECR repository                   | 5     | `bash infra/helm/check.sh` lists a brand-a combination; `argocd app get storefront-brand-a-<env>` | ❌  |

## 3. Keycloak customers client

| #   | Item                                                                                                                                                  | Owner | Verify                                                                                                                                                  | Now |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 3.1 | Client `storefront-brand-a`: public, PKCE S256, no direct grants, `email_verified` + `store_code` mappers                                             | 2     | `pnpm --filter @platform/auth-sdk test` (`keycloak-realms` tests: 129 passed)                                                                           | ✅  |
| 3.2 | Production realm: only brand A's exact callback, `sslRequired: all`, `verifyEmail: true` with SMTP, no seeded users, no `test-cli`, a password policy | 2 / 5 | `https://<keycloak>/realms/customers/.well-known/openid-configuration` → 200; the "Dev-only settings" table in `infra/keycloak/README.md`, item by item | ⛔  |
| 3.3 | A deployed Keycloak (Postgres, not dev-file)                                                                                                          | 5     | as 3.2                                                                                                                                                  | ❌  |
| 3.4 | Sign-in round trip on the real host                                                                                                                   | 10    | `E2E_BASE_URL=https://<host> … pnpm --filter @platform/storefront-brand-a e2e account`                                                                  | ⛔  |

## 4. Payments (Stripe)

| #   | Item                                                                                    | Owner     | Verify                                                                                                     | Now |
| --- | --------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- | --- |
| 4.1 | Stripe account for brand A; keys in `<env>/stores/brand-a/stripe`                       | owner / 5 | Stripe dashboard; `kubectl get externalsecret` for the core                                                | ⛔  |
| 4.2 | **Hosted payment fields in checkout.** Today checkout offers only the `manual` provider | 7 / 3     | a checkout that shows the Stripe Payment Element; `pnpm --filter @platform/core test` (FakeStripe)         | ❌  |
| 4.3 | Webhook `POST /webhooks/stripe/brand-a` registered with the signing secret              | 7 / 5     | `stripe listen --forward-to localhost:9000/webhooks/stripe/brand-a`, then the dashboard's test event → 2xx | ⛔  |
| 4.4 | Live keys accepted. **Refused by design in Phase 2** (`sk_live_` / `rk_live_`)          | 7         | a deliberate Phase 3 change, reviewed                                                                      | ❌  |

## 5. Search index

| #   | Item                                                                                    | Owner | Verify                                                                                                  | Now |
| --- | --------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- | --- |
| 5.1 | Algolia index `brand-a_products` + replicas `_price_asc`, `_price_desc`, `_newest`      | 9     | `pnpm --filter @platform/core exec tsx src/modules/search/cli/index-products.ts --store brand-a --full` | ⛔  |
| 5.2 | Re-index on catalogue change (a scheduler or event consumer, deployed)                  | 9 / 5 | an edited product appears in an Algolia query within the agreed delay                                   | ❌  |
| 5.3 | Shopper search reaches Algolia. Today the Store API answers `q` with a database `ILIKE` | 1 / 9 | a typo-tolerant query on `https://<host>/en-GB/products?q=…`                                            | ❌  |

## 6. CMS dataset

| #   | Item                                                                                                            | Owner      | Verify                                                                                                                                                                                                                                                                                                                                                                                                                                                | Now |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 6.1 | Brand A's 20 documents valid against the schemas, media slots resolved                                          | 10         | `node cms/brand-a/scripts/seed-content.mjs --dry-run` → "20 documents valid"                                                                                                                                                                                                                                                                                                                                                                          | ✅  |
| 6.2 | Dataset `brand-a` seeded in the platform's Sanity project                                                       | 10 / owner | `node cms/brand-a/scripts/seed-content.mjs --yes` (needs `SANITY_PROJECT_ID`, `SANITY_WRITE_TOKEN`)                                                                                                                                                                                                                                                                                                                                                   | ⛔  |
| 6.3 | Revalidation webhook from Sanity to `POST /api/cms/revalidate`, signed                                          | 6 / 5      | an edit published in the Studio shows on the page within seconds                                                                                                                                                                                                                                                                                                                                                                                      | ⛔  |
| 6.4 | **Go-live gate (waived from #142):** content routes render in both locales **on staging** with the real dataset | 10         | `for p in en-GB/pages/about de-DE/pages/about en-GB/pages/cloth de-DE/pages/cloth en-GB/legal/imprint de-DE/legal/imprint en-GB/legal/privacy de-DE/legal/privacy en-GB/legal/terms de-DE/legal/terms en-GB/legal/returns de-DE/legal/returns; do curl -s -o /dev/null -w "%{http_code} $p\n" https://<host>/$p; done` → all `200`; then `CMS_DATASET=brand-a E2E_BASE_URL=https://<host> pnpm --filter @platform/storefront-brand-a e2e routes a11y` | ⛔  |
| 6.5 | Sitemap lists the content routes in both locales                                                                | 10         | `curl -s https://<host>/sitemap/0.xml \| grep -c '/pages/\|/legal/\|/campaign/'` ≥ 14                                                                                                                                                                                                                                                                                                                                                                 | ⛔  |

## 7. Imagery (Cloudinary)

| #   | Item                                                                                                                  | Owner                 | Verify                                                                                                                       | Now |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --- |
| 7.1 | All 21 media files intact against the manifest                                                                        | 10                    | `node cms/brand-a/scripts/upload-media.mjs --from <media dir>` → "21 files verified"                                         | ✅  |
| 7.2 | **Owner action:** create the Cloudinary account (a paid plan: 18 of 19 stills exceed the free 10 MB limit) and upload | owner                 | `CLOUDINARY_*_BRAND_A=… node cms/brand-a/scripts/upload-media.mjs --from <media dir> --yes` → 21 `uploaded`/`exists`         | ⛔  |
| 7.3 | Seed with the cloud name so the 18 image placements resolve                                                           | 10                    | `CLOUDINARY_CLOUD_NAME_BRAND_A=<cloud> node cms/brand-a/scripts/seed-content.mjs --dry-run` prints **no** "left out" warning | ⛔  |
| 7.4 | Product images (the catalogue seed's product matrix) served from Cloudinary, not picsum                               | manager (packages/db) | `curl -s https://<core>/store/products?limit=1 -H 'x-publishable-key: <pk>' \| grep -c res.cloudinary.com` > 0               | ⛔  |
| 7.5 | Hero video loops. Waiting on REQUEST #330, accepted for Phase 3. Brand A ships image-only                             | 6 / 3                 | —                                                                                                                            | —   |

## 8. Analytics and consent

| #   | Item                                                                                                                  | Owner          | Verify                                                                      | Now |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------- | --- |
| 8.1 | **Consent decision.** The storefront sets `sf_attribution` (first-party UTM/referral, 30 days) without a consent gate | owner + lawyer | a written decision: strictly necessary, or behind consent                   | ⛔  |
| 8.2 | Consent banner, if 8.1 says so                                                                                        | 3              | first visit shows it; no `sf_attribution` before consent (browser devtools) | ❌  |
| 8.3 | Client analytics. `apps/analytics-ingest` is a Phase 5 scaffold                                                       | 12             | events arrive in the ingest                                                 | ❌  |

## 9. Legal pages

| #   | Item                                                                                                                                                                                                        | Owner          | Verify                                                                          | Now |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- | --- |
| 9.1 | Imprint, privacy, terms and returns exist in both locales and render                                                                                                                                        | 10             | `pnpm --filter @platform/storefront-brand-a test` (`cms-brand-content.test.ts`) | ✅  |
| 9.2 | **Owner action:** fill the **48 placeholders** (19 distinct: company name, address, VAT ID, register court and number, managing director, DPO contact, retention period, dispatch window, returns address…) | owner          | `grep -c '\[\[' cms/brand-a/content/legal.json` → `0`                           | ⛔  |
| 9.3 | **Owner action:** lawyer review of all four documents in both locales (they are **not** lawyer-reviewed; the en-GB imprint cites German statutes)                                                           | owner + lawyer | a dated sign-off recorded in `cms/brand-a/README.md`                            | ⛔  |

Today 9.2 reads `48`. A launch build should fail while any `[[` remains; that guard does not exist
yet (Phase 3, window 10).

## 10. Monitoring and alerts

| #    | Item                                                                                                                | Owner | Verify                                                                                                                                                                          | Now |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 10.1 | Liveness: `GET /health` → 200                                                                                       | 10    | `curl -s https://<host>/health`                                                                                                                                                 | ⛔  |
| 10.2 | `/health` names the app. It says `storefront-starter`, inherited from the starter                                   | 3     | `curl -s …/health` → `"app":"storefront-brand-a"`                                                                                                                               | ❌  |
| 10.3 | Dashboards and alert rules (Alertmanager or Grafana Cloud). Only a local stack and one dashboard exist              | 5     | `bash infra/observability/check.sh` (static, passed); a test alert reaches the on-call channel                                                                                  | ❌  |
| 10.4 | Error tracking in the storefront (Sentry or OTel). No SDK today                                                     | 3 / 5 | a thrown test error appears in the project                                                                                                                                      | ❌  |
| 10.5 | **Go-live gate (waived from #142):** Google Rich Results test passes on the deployed home, listing and product URLs | 10    | https://search.google.com/test/rich-results for `https://<host>/en-GB`, `/en-GB/products`, `/en-GB/products/<handle>`: no errors                                                | ⛔  |
| 10.6 | Lighthouse on the deployed host: performance ≥ 0.9, accessibility ≥ 0.9, SEO ≥ 0.95 (worst of three)                | 10    | `pnpm --filter @platform/storefront-brand-a perf` locally (CI `perf-app` covers brand A, #283); deployed: `npx -y @lhci/cli@0.14.0 collect --url=https://<host>/en-GB/products` | ⛔  |

## 11. Release and rollback

| #    | Item                                                                                                                                               | Owner | Verify                                                                                                                                                  | Now |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 11.1 | Brand A's image builds and copies every workspace manifest                                                                                         | 5     | `bash infra/ci/check-image-manifests.sh` → "every app Dockerfile copies all 14 workspace manifests"                                                     | ✅  |
| 11.2 | Infrastructure code valid                                                                                                                          | 5     | `bash infra/terraform/check.sh`, `bash infra/helm/check.sh`                                                                                             | ✅  |
| 11.3 | Image tags are git SHAs committed to values; rollback = `git revert` of the deploy commit, or `argocd app rollback storefront-brand-a-<env> <rev>` | 5     | **rehearsed once on staging**: deploy, roll back, `curl -s https://<host>/health` answers from the previous SHA                                         | ❌  |
| 11.4 | Brand A e2e in CI (`E2E_INCLUDE_BRAND_STOREFRONTS=1`)                                                                                              | 5     | REQUEST #295 merged; the CI `e2e` job lists brand A's specs                                                                                             | ❌  |
| 11.5 | The suite passes against the deployed stack                                                                                                        | 10    | `E2E_BASE_URL=https://<host> E2E_STORE_API_URL=https://<core> E2E_REQUIRE_CORE=1 E2E_REQUIRE_KEYCLOAK=1 pnpm --filter @platform/storefront-brand-a e2e` | ⛔  |

---

## Dry run

### Against staging — not possible on 2026-10-05

There is no staging. `deploy-staging.yml` needs `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REGISTRY`,
`ARGOCD_SERVER` and `ARGOCD_AUTH_TOKEN`, and none exists. Window 5's memory records the cloud
credentials as missing. Brand A is also absent from the deploy matrix, the Terraform `apps` list and
the Helm values (item 2.4). One thing to settle before the first staging deploy: the **starter's**
staging values carry brand A's dev publishable key (`values-staging.yaml:45`), so "staging" would
serve store `brand-a` through the starter app, not through brand A.

### On a laptop, 2026-10-05, main 8690267, no docker and no running core

| Check                                                                            | Result                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm --filter @platform/storefront-brand-a test`                                | ✅ 687 passed, 2 skipped (`starter-defaults` skips itself)                      |
| `pnpm --filter @platform/storefront-brand-a typecheck`                           | ✅ clean                                                                        |
| `node apps/storefronts/brand-a/scripts/sync-from-starter.mjs --check`            | ✅ manifest current; no preserved-file drift                                    |
| `node cms/brand-a/scripts/seed-content.mjs --dry-run`                            | ✅ 20 documents valid; one warning: 18 optional images left out (no cloud name) |
| `node cms/brand-a/scripts/upload-media.mjs --from <media dir>`                   | ✅ 21 files verified against the manifest; plan only (no credentials)           |
| `bash infra/helm/check.sh`                                                       | ✅ 10 app/environment combinations plus ArgoCD (none is brand A)                |
| `bash infra/terraform/check.sh`                                                  | ✅ valid, `envs/staging` included                                               |
| `bash infra/ci/check-image-manifests.sh`                                         | ✅ brand A's Dockerfile copies all 14 manifests                                 |
| `bash infra/observability/check.sh`                                              | ✅ passed                                                                       |
| `pnpm --filter @platform/auth-sdk test` (realm tests incl. `storefront-brand-a`) | ✅ 129 passed                                                                   |
| `grep -c '\[\[' cms/brand-a/content/legal.json`                                  | ⛔ placeholders remain (48 across the four documents × 2 locales)               |

Measured earlier against the local stack and recorded in the CHANGELOG: three consecutive full e2e
passes against the core, 91 passed / 0 failed each (#337); Lighthouse SEO 1.00 worst of three on
home, PLP, PDP and the de-DE PLP, with hreflang in `<head>` in 280/280 raw-byte checks (#328).

## Owner actions, in launch order

1. Choose and register the domain (1.1).
2. Open the AWS account and give window 5 the deploy settings, so staging exists (§ Dry run).
3. Open the Stripe account (4.1), the Cloudinary account on a paid plan (7.2), and the Sanity
   project if it isn't the platform's existing one (6.2).
4. Fill the 48 legal placeholders and get the four documents lawyer-reviewed in both locales (9.2, 9.3).
5. Decide on consent for `sf_attribution` (8.1).
6. Sign off the two go-live gates waived from #142 once staging runs: content routes in both
   locales (6.4), and the Google Rich Results test (10.5).
