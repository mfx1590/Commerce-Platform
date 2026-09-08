# Changelog — marketing module (window 17)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — marketing/phase2 (contracts-v0.3)

### 2026-09-08 · 2.1 Campaign module with attribution report (#145)

First code in this folder.

- `types.ts`: the contract shapes (`Campaign`, `CampaignInput`, `AttributionReport`, `Money`) re-exported from
  `@platform/contracts`, the enums as runtime arrays (`CAMPAIGN_TYPES`, `CAMPAIGN_STATUSES`,
  `CAMPAIGN_SORT_FIELDS`, `TOUCHES`), the legal transition sets (`LAUNCHABLE`, `ENDABLE`), and `CampaignRow` — the
  table shape of migration 0120, kept deliberately separate from the contract shape.
- `campaigns.ts`: CRUD + `launchCampaign` / `endCampaign` over a store-scoped `ScopedClient`. Every statement
  filters `store_id` explicitly on top of RLS. `createCampaign` always produces a `draft`; `delete` is refused
  with 409 for anything else; an `ended` campaign can no longer be edited (it is what the report reads as
  history). `campaign.launched` / `campaign.ended` are written through `withEvents` in the same transaction as
  the status change; create/update/delete are audited, not evented. A relaunch keeps the first `launched_at`.
- `normaliseCampaignInput` enforces the two table CHECKs (`ends_at >= starts_at`, budget requires a currency) as
  `validation_error`, so the API answers 400 with a field name instead of a Postgres constraint name.
- Budget mapping: contract `Money` ⇄ `budget_minor` + `currency`, in the service only (manager decision
  2026-09-08 — no contract change).
- `reports.ts`: `attributionReport` — `attribution` joined to `"order"` (placed in `[from, to)`, not cancelled),
  grouped by utm source/medium/campaign for one touch model. Campaign linking happens **at report time** by
  case-insensitive `utm_campaign` match within the store, so `attribution.campaign_id` stays NULL as window 1
  writes it and a campaign created later still claims its orders. Orders with no attribution row are reported as
  `direct`, so the totals reconcile with the order list.
- `routes.ts`: `marketingAdminRouter()` — the seven campaign operations plus `getAttributionReport`, built the
  same way as `src/http/admin-routes.ts` (`x-permission` read from `admin-api.yaml` at runtime, bodies validated
  against the operation's `requestBody` schema). `enumParam` is duplicated locally: `src/http/query.ts` has it but
  does not export it through `src/http/index.ts`, and reaching past a folder's public API is what the module
  rules forbid (noted in the REQUEST).
- Not mounted yet: `src/http` and `src/server.ts` are window 1's. The mount line is a `REQUEST:` issue; until it
  lands `routes.test.ts` mounts the router behind the real middleware chain on a bare Express app.
- Tests (23): `marketing.test.ts` — CRUD, transitions and their outbox events, audit rows, tenant isolation
  across brand A/B, and the report (first vs last touch, `direct` orders, case-insensitive campaign linking,
  exclusion of cancelled / out-of-window / other-currency orders). `routes.test.ts` — every operation against the
  spec's components, `store_staff` read vs `store_admin` write vs `viewer` on reports, 400/401/403/404/409 bodies.

**Known limitation:** the report aggregates in the store's default currency and excludes orders in other
currencies (`AttributionReport` has one `currency` and no way to declare a mix). Manager decision 2026-09-08:
keep the exclusion, revisit at Integration 2 when multi-currency orders exist. Documented in README.md.
