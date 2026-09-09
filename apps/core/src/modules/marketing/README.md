# marketing module

Owner: **window 17 (marketing)** · Branch prefix `marketing/` · Spec: [docs/marketing-scope.md](../../../../../docs/marketing-scope.md)
Contracts: `contracts-v0.3` — Admin API 0.3.0, events 0.2.0, db 0.2.0 (migration `0120_marketing.sql`).

Campaigns, attribution reporting, segments, feeds and referrals for a store. Phase 2.1 delivers **campaigns and
the attribution report**, 2.2 **product feeds**; segments (2.3) and abandoned-cart recovery (2.4) land here too.
The feed _files_ are served by `apps/feeds` — this module generates and stores them.

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

## Product feeds (2.2, #146)

A publish is four steps, each its own file and testable alone: **build** the rows from the catalogue
(`feed-items.ts`) → **validate** them against the channel's required fields (`feed-validation.ts`) → **render**
the file (`feed-render.ts`) → **store** it (`storage.ts`). `feeds.ts` is the job that runs them and records what
happened. `apps/feeds` serves the result; see its README for the split and why it is that way round.

**A bad row is reported, never silently dropped** (#146). It keeps its error codes and is still returned by
`listFeedItems`, so a merchandiser can see which product is wrong and why; it does not go into the file, because
the channel would reject it on ingest anyway; and one `{ code, message, product_id }` lands on
`product_feed.errors`. A missing GTIN is the exception — Google warns rather than rejects, so it is reported but
does not keep the row out.

**Idempotency per content hash.** The hash comes from the **stored artifact**, not from a column: `product_feed`
has no hash field and `packages/db` is frozen, so hashing what is already stored avoids a contract change.
Re-publishing identical bytes writes no file and emits no `feed.published`, and `last_published_at` therefore
means _when the file last changed_ — the question a channel actually asks. `status`, `url`, `item_count` and
`errors` are refreshed on every run, changed or not, so the admin never reads a stale verdict. **Both renderers
are deterministic** (no timestamps, no generated ids, stable ordering) — a `lastBuildDate` element would make
every publish look like a change and defeat the whole mechanism.

**Statuses.** `active` when the file is usable; `error` when it is not — a feed-level failure (the store has no
domain, so nothing can be linked) or every row rejected. An empty catalogue is `active` with `item_count: 0`: an
empty feed is a true statement about a store with nothing published, not a failure. `tiktok` and `pinterest` are
storable but not renderable yet, so publishing one is a 409 rather than an empty file.

**Prices.** `price` is the list price and `sale_price` the discounted one, so our `compare_at_minor` ("was")
flips the two on a genuine markdown. Amounts are converted to major units with the ISO 4217 exponent —
`1999 JPY` is 1999, not 19.99.

### Known contract bug — `ProductFeed.status`

Admin API 0.3.0 defines `ProductFeed` as `allOf: [ProductFeedInput, { … status: [draft, active, paused, error] }]`
while `ProductFeedInput.status` is `[draft, active, paused]`. Under `allOf` a value must satisfy **both**
branches, so a feed in `error` — the status `publishFeed`'s own summary produces — is rejected by the document,
and the generated TypeScript intersects the unions down to three values. Filed as a CONTRACT CHANGE with the
exact diff (spell the schema out instead of composing it; no field changes). Until it lands, `feed-types.ts`
carries the corrected read type and error-status responses are asserted in tests against
`proposed/product-feed.schema.json` — the same `proposed/` pattern window 9 used in #162.

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
`cart.abandoned` consumer, 2.6 the promotions report. The feed _server_ is `apps/feeds`; the admin screens are
in `apps/admin/src/app/(store)/[storeId]/marketing/**`.
