# marketing module

Owner: **window 17 (marketing)** · Branch prefix `marketing/` · Spec: [docs/marketing-scope.md](../../../../../docs/marketing-scope.md)
Contracts: `contracts-v0.3` — Admin API 0.3.0, events 0.2.0, db 0.2.0 (migration `0120_marketing.sql`).

Campaigns, attribution reporting, segments, feeds and referrals for a store. Phase 2.1 delivers **campaigns and
the attribution report**; segments (2.3) and abandoned-cart recovery (2.4) land in this folder, product feeds in
`apps/feeds`.

## The one rule this module exists to keep

> Every reported number comes from `attribution` rows and orders. Never from a pixel.

Attribution touches are captured server-side by the storefront into `cart.metadata.attribution` and written to the
`attribution` table by the core at order placement (`src/lib/attribution.ts`, window 1). This module only reads
them. It follows that the report is unaffected by ad blockers and reconciles with the order list — and that a
number here can be compared with the ledger later without a caveat.

Marketing **never mutates orders, prices or stock**. In 2.1 the only tables written are `campaign`, `audit_log`
and `outbox`.

## Public API (`index.ts`)

| Export                                                                                               | What                                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `listCampaigns` `getCampaign` `createCampaign` `updateCampaign` `deleteCampaign`                     | campaign CRUD over a store-scoped `ScopedClient`                         |
| `launchCampaign` `endCampaign`                                                                       | the two status transitions, each with its event                          |
| `attributionReport`                                                                                  | orders and revenue by utm source/medium/campaign for one touch model     |
| `marketingAdminRouter()`                                                                             | the Admin API routes below, as an Express router                         |
| `toCampaign` `normaliseCampaignInput`                                                                | row → contract shape, and input validation (exported for tests and jobs) |
| `CAMPAIGN_TYPES` `CAMPAIGN_STATUSES` `CAMPAIGN_SORT_FIELDS` `LAUNCHABLE` `ENDABLE` `TOUCHES` + types | the contract enums, in one place                                         |

Nothing outside this folder may import from any other file here.

## Routes and permissions

Read from each operation's `x-permission` in `admin-api.yaml` at runtime — never hard-coded here.

| Operation                                              | Method + path                                            | Permission    |
| ------------------------------------------------------ | -------------------------------------------------------- | ------------- |
| `listCampaigns` / `getCampaign`                        | `GET /admin/stores/{storeId}/marketing/campaigns[/{id}]` | `store_staff` |
| `createCampaign` / `updateCampaign` / `deleteCampaign` | `POST` / `PATCH` / `DELETE` on the same paths            | `store_admin` |
| `launchCampaign` / `endCampaign`                       | `POST …/campaigns/{id}/launch` · `…/end`                 | `store_admin` |
| `getAttributionReport`                                 | `GET …/marketing/reports/attribution`                    | `viewer`      |

`viewer` is the spec's "any relation on the store" convention (Integration 1 decision), so an HQ analyst reads the
report next to store staff without gaining access to the campaign rows.

### Mounting

`src/http` and `src/server.ts` belong to window 1, so this router is **not** mounted by the module itself: it is
exported from `index.ts` and mounted by one line in `src/http/admin-routes.ts`, requested in a `REQUEST:` issue
(the route #162 took for merchandising). Until that line lands, `routes.test.ts` mounts the router on a bare
Express app behind the real middleware chain, which is what proves the contract shapes.

## Behaviour worth knowing

**Campaign status.** `createCampaign` always produces a `draft`. `launch` accepts `draft` / `scheduled` /
`paused`; `end` accepts `active` / `paused`; anything else is a `409 conflict` naming the current status. A
relaunch keeps the first `launched_at`. `ended` is final — an ended campaign cannot be edited or deleted, because
the attribution report reads it as a historical record and changing its `utm_campaign` would rewrite which orders
belong to it. `delete` is only for a `draft` (the contract: "409 once launched; end it instead").

**Budget.** The contract carries `budget` as a `Money` object; migration 0120 stores `budget_minor` + `currency`.
`toCampaign` / `normaliseCampaignInput` are the only translation between the two (manager decision 2026-09-08 — map
in the service, no contract change). No budget at all reads back as `null`, never as a zero-amount `Money`.

**Events.** `campaign.launched` and `campaign.ended` go through `withEvents` in the same transaction as the status
change (ADR 0003); nothing here publishes to the bus. Payloads carry ids, amounts and utm strings — no PII.
Optional fields are omitted rather than sent as `null`, because their schemas `$ref` the uuid/timestamp/money
definitions, which do not accept null. Creating, editing and deleting a campaign emit no event; they are audited.

**Campaign linking is done at report time**, not at placement. `src/lib/attribution.ts` deliberately leaves
`attribution.campaign_id` NULL, and the report matches `lower(utm_campaign)` within the store (#145). A campaign
created or renamed after the orders arrived therefore still claims them, and no attribution row is ever rewritten.
Two campaigns sharing a `utm_campaign` resolve to the oldest, deterministically.

**What the report counts.** Orders placed in `[from, to)`, not `cancelled`, in the store's default currency, split
by the `first` or `last` touch. Orders with no attribution row appear as one `direct` item, so
`totals.orders_count` reconciles with the store's order list instead of quietly losing revenue.

### Known limitation — currency

The report aggregates in the **store's default currency and excludes orders in any other currency**.
`AttributionReport` carries one `currency` for the whole document and has no field to declare a mix, so reporting
across currencies would need a contract change. Multi-currency orders do not exist yet in Phase 2; the manager's
decision (2026-09-08) is to keep the exclusion and revisit at Integration 2, when they do. Until then a store
selling in more than one currency under-reports, and this paragraph is the only warning it gets.

## Run / test

```bash
pnpm --filter @platform/core exec vitest run src/modules/marketing
pnpm lint && pnpm typecheck && pnpm test --filter @platform/core
```

Tests create their own throwaway database through `@platform/db/testing` (never the shared docker stack) and seed
it; the route tests use dev tokens (`CORE_DEV_TOKENS=1`) for the seeded staff subjects, exactly as
`test/admin-api.test.ts` does.

## Next in this folder

2.3 segments (rule grammar frozen there, `SegmentRules` in the spec is deliberately loose), 2.4 the
`cart.abandoned` consumer, 2.6 the promotions report. Feeds live in `apps/feeds`; the admin screens in
`apps/admin/src/app/(store)/[storeId]/marketing/**`.
