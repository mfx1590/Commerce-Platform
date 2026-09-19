# marketing module

Owner: **window 17 (marketing)** · Branch prefix `marketing/` · Spec: [docs/marketing-scope.md](../../../../../docs/marketing-scope.md)
Contracts: `contracts-v0.3` — Admin API 0.3.0, events 0.2.0, db 0.2.0 (migration `0120_marketing.sql`).

Campaigns, attribution reporting, segments, feeds and referrals for a store. Phase 2.1 delivers **campaigns and
the attribution report**, 2.2 **product feeds**, 2.3 **segments**; abandoned-cart recovery (2.4) lands here too.
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
exact diff (spell the schema out instead of composing it; no field changes) — landed as Admin API 0.4.1 (#194):
`feed-types.ts` now uses the generated `ProductFeed` and the tests assert error-status responses against the
document (`proposed/` removed).

## Segments (2.3, #147)

### The rule grammar is frozen

    { v: 1, all: [ { any: [ { field, op, value }, … ] }, … ] }

An **AND of ORs** over a **closed** predicate set. Every group in `all` must match; a group matches when any one
of its predicates does. `all: []` matches every customer of the store — a new segment starts there.

| field                | operators               | value                                    |
| -------------------- | ----------------------- | ---------------------------------------- |
| `orders_count`       | `gte` `lte` `eq`        | integer                                  |
| `total_spent_minor`  | `gte` `lte` `eq`        | integer, minor units                     |
| `last_order_at`      | `after` `before`        | RFC-3339, normalised to ISO-8601 on save |
| `tags`               | `includes` `excludes`   | string                                   |
| `consent`            | `granted` `not_granted` | `email` \| `sms`                         |
| `country`            | `in` `not_in`           | array of ISO-3166-1 alpha-2              |
| `customer_group_ids` | `in` `not_in`           | array of uuid                            |

**Anything else is a 400** naming the exact path (`rules.all[0].any[2].op`). A segment that silently ignored a
rule it did not understand would send the wrong campaign to the wrong people and nobody would find out; a
refusal is a validation message. `SEGMENT_RULES_SCHEMA` publishes the same grammar as JSON Schema from
`index.ts`, so window 16's worker and the admin rule builder validate without importing this module — and a test
runs both the parser and the schema over the same fixtures so they can never drift apart.

### Where each field actually reads from

Decided with the manager on 2026-09-19 after checking the schema rather than the contract's description:

- `orders_count` / `total_spent_minor` / `last_order_at` — aggregated from `"order"`, **excluding cancelled**.
- `consent` — `customer.consent` jsonb, `{marketing_email: {granted: true}}`; the contract's `email`/`sms`
  map to `marketing_email` / `marketing_sms`.
- `country` — **the default shipping address only** (`customer_address.is_default_shipping`). A stale secondary
  address must never pull someone into a geo campaign. "Any address ever" would be a separate additive
  predicate later, deliberately not built now.
- `tags` — `customer.metadata.tags`; there is no `customer.tags` column. A missing key or a non-array value is
  simply "no tags", never an error.
- `customer_group_ids` — membership-in-list against the single `customer.customer_group_id` FK.
- Customers with status `erased` or `disabled` are never counted, in any segment.

**Every predicate is total.** A customer with no orders, no address, no tags and no consent block still
evaluates to true or false — never an error, and never a NULL that quietly drops them. That last one is not
theoretical: `not_granted` is `IS DISTINCT FROM`, because `NOT (NULL = 'true')` is NULL, which silently excluded
exactly the never-asked customers a re-consent campaign exists to reach. A test covers it.

Nothing from a rule is ever interpolated into SQL — values are bound as parameters, and only field and operator
names (already checked against the closed set) reach the query string.

### Preview, materialise, and why they agree

`previewSegment` counts and writes nothing; rules in the request body override the saved ones so a rule builder
can show a live count before anything is saved. `materializeSegment` replaces `segment_member` in one
transaction and updates `materialised_count` / `last_materialised_at`. Both go through the same `segmentQuery`,
so "the preview count equals the materialised count" is a property of the code rather than two queries that
happen to agree today. Members are **replaced, not merged** — a segment is a statement about the present, which
is why `segment_member` has no `updated_at`.

`materialize` answers **202**: the contract calls it a job, so moving it onto a worker later is not a contract
change even though it currently completes inline.

### Templates

`store_id IS NULL` is an organization template. RLS kind `store_nullable` makes templates visible **only** in
organization scope, so a store client cannot see one even by id — there is a test for that. Creating a store
segment with `template_id` **copies** the rules at creation: editing the template afterwards never silently
changes who a live campaign reaches, and deleting it leaves the segment working. `template_id` is history, not a
live link.

That copy has to be read in organization scope, and a `store_admin` has no HQ role — so `createSegment` reads the
template through an injected organization-scoped client (`templateClient`), defaulting to one built from the core
pool. Injected rather than always built, because a service that reaches for the process-global pool cannot be
tested without `initDb()`.

### The window 16 boundary

`segmentSyncPayload(client, storeId, segmentId, { limit, after })` returns one page of the segment's
**materialised** members. **No provider call happens in this module and none ever will** — window 16 owns
delivery, credentials and Klaviyo's quirks.

It reads `segment_member` rather than re-evaluating the rules on purpose: the worker must send to the set the
segment was last materialised as, so that what was previewed, what was counted and what was sent are the same
set. A member is `{ customer_id, email_hash, consent, materialised_at }` — **no address, name or phone**, the
same convention the event envelopes use.

### Known contract gap — `SegmentRules` (CONTRACT CHANGE filed)

Admin API 0.4.3 still describes `SegmentRules` as the flat `{ orders_count, tags, consent, … }` bag with
`additionalProperties: true` and "Unknown keys are kept, not rejected" — while its own description says the
grammar is frozen by this window in Phase 2.3, which is what this task does. The filed change replaces that
schema with the closed grammar above. Responses validate against the frozen document meanwhile precisely because
it accepts additional properties, so nothing was blocked; the manager lands it after this PR merges.

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

2.4 the `cart.abandoned` consumer, 2.6 the promotions report. The feed _server_ is `apps/feeds`; the admin
screens are in `apps/admin/src/app/(store)/[storeId]/marketing/**`.
