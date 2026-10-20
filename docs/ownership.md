# Ownership map (enforced by scripts/check-ownership.sh in CI)

Branch prefix → allowed write paths. Everything else is read-only for that branch.
`main/*` and `integration/*` may write anywhere. `packages/contracts`, `packages/events`, `packages/db` (schema), `docs/`, root config: main window only.

| Branch prefix | Window | Allowed write paths |
|---|---|---|
| `core/` | 1 — Core commerce | `apps/core/**`, `packages/db/** (via PR only, main window approves)` |
| `auth/` | 2 — Auth & RBAC | `packages/auth-sdk/**`, `infra/keycloak/**`, `infra/openfga/**`, `apps/core/src/modules/hq-rbac/**` |
| `storefront/` | 3 — Storefront starter & UI kit | `apps/storefront-starter/**`, `packages/ui/**` |
| `admin/` | 4 — Admin application | `apps/admin/**` |
| `infra/` | 5 — Infra & DevOps | `infra/**`, `.github/workflows/**`, `**/Dockerfile`, `.dockerignore` |
| `cms/` | 6 — CMS & landing pages | `cms/*`, `cms/src/**`, `cms/scripts/**`, `cms/test/**` (the cms/brand-*/** content folders belong to brands/), `apps/storefront-starter/src/app/[locale]/(content)/**`, `apps/storefront-starter/src/app/api/cms/**`, `apps/storefront-starter/src/lib/cms/**`, `apps/storefront-starter/test/cms-*` |
| `payments/` | 7 — Payments, tax, fraud | `apps/core/src/modules/payments/**`, `apps/core/src/modules/tax/**`, `apps/core/src/modules/fraud/**` |
| `shipping/` | 8 — Shipping & fulfillment | `apps/core/src/modules/fulfillment/**`, `apps/core/src/modules/shipping/**` |
| `search/` | 9 — Search, media, promotions | `apps/core/src/modules/search/**`, `apps/core/src/modules/promotions/**`, `apps/core/src/jobs/index-*.ts` |
| `brands/` | 10 — Brand storefronts (A, B, C…) | `apps/storefronts/<brand>/**`, `cms/brand-*/**` |
| `warehouse/` | 11 — Shared warehouse / WMS | `apps/core/src/modules/hq-warehouse/**`, `apps/wms-adapter/**` |
| `data/` | 12 — Data platform, BI & AI | `data/**`, `apps/analytics-ingest/**`, `apps/core/src/modules/reporting/**`, `apps/admin/src/app/(hq)/bi/**`, `apps/admin/test/bi/**`, `apps/admin/test-contract/bi/**`, `apps/admin/e2e/bi/**` (reporting v1, issues 478-480: views proposed under data/reporting and landed by the main window; the core reporting module and the admin BI section are window 12; route mounting stays window 1 via REQUEST, the admin rail stays window 4) |
| `customers/` | 13 — Customer accounts & identity | `apps/core/src/modules/customers/**`, `apps/core/src/http/customer-routes.ts`, `apps/core/src/jobs/customer-*.ts`, `apps/core/test/customers-api.test.ts`, `apps/core/test/admin-customers.test.ts`, `apps/storefront-starter/src/app/[locale]/(account)/**`, `apps/storefront-starter/src/components/account-*.tsx` (window 13 owns the customer module since Phase 3, issues 470-473; route mounting in admin-routes.ts and store-routes.ts stays window 1 via REQUEST; brand copies of the account pages stay window 10) |
| `events/` | 14 — Event bus & outbox relay | `apps/core/src/outbox/**`, `infra/redpanda/**`, `packages/events/** (exception this phase only)` |
| `accounting/` | 15 — Automatic accounting | `apps/accounting/**` |
| `engagement/` | 16 — CRM, notifications & support | `apps/notifications/**`, `apps/support/**`, `data/cdp/**` |
| `marketing/` | 17 — Marketing (campaigns, feeds, segments, attribution, referrals, reviews, transactional email since 2026-10-07 #360) | `apps/core/src/modules/marketing/**`, `apps/feeds/**`, `apps/notifications/**`, `apps/admin/src/app/(store)/[storeId]/marketing/**`, `apps/admin/src/app/(hq)/marketing/**`, `apps/admin/test/marketing/**`, `apps/admin/test-contract/marketing/**` |

Rules:
1. A window that needs a change outside its paths files a GitHub issue titled `CONTRACT CHANGE: …` or `REQUEST: …` and keeps building against a local mock.
2. Shared memory: every window writes only its own `docs/memory/Memory-<n>-<key>.md`. Only the main window writes `Memory-main.md` and other windows' files.
3. Nobody merges their own PR: run the Reviewer session (docs/start-messages/00-reviewer.md) first.
