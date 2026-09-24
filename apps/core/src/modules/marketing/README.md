# marketing module

Owner: **window 17 (marketing)** · Branch prefix `marketing/` · Spec: [docs/marketing-scope.md](../../../../../docs/marketing-scope.md)
Contracts: `contracts-v0.4.5` (migrations `0120_marketing.sql` and `0170_cart_recovery.sql`).
Status: **Phase 2 complete** — 2.1 campaigns and the attribution report (#145), 2.2 product feeds (#146), 2.3
segments (#147), 2.4 abandoned-cart recovery (#148), 2.5 the admin section (#149, lives in `apps/admin`), 2.6
this documentation pass and the end-to-end test (#150).

The feed _files_ are served by `apps/feeds` — this module generates and stores them. The admin screens are in
`apps/admin/src/app/(store)/[storeId]/marketing/**` and `(hq)/marketing/**`, with their own README.

## The one rule this module exists to keep

> Every reported number comes from `attribution` rows and orders. Never from a pixel.

Attribution touches are captured server-side by the storefront into `cart.metadata.attribution` and written to the
`attribution` table by the core at order placement (`src/lib/attribution.ts`, window 1). This module only reads
them. It follows that the report is unaffected by ad blockers and reconciles with the order list — and that a
number here can be compared with the ledger later without a caveat.

Marketing **never mutates orders, prices or stock**. Every table it writes, and nothing else:

| Table                               | Written by                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `campaign`                          | campaign CRUD and `launch` / `end`                                         |
| `product_feed`                      | feed CRUD and `publishFeed` (status, url, counts, errors)                  |
| `segment`, `segment_member`         | segment CRUD; `materializeSegment` replaces the members                    |
| `cart_recovery`, `marketing_cursor` | the `cart.abandoned` consumer, redemption, `reconcileRecoveries`           |
| `cart` — **`status` only**          | a redeemed recovery link sets `abandoned → active`, guarded on `abandoned` |
| `audit_log`, `outbox`               | every mutation / every state change with an event, same transaction        |

The one write outside marketing's own tables is that cart reactivation: it is the same transition window 1's
cart module performs on any mutation of an abandoned cart, it touches no line, price or total, and it is what
makes a recovery link land the customer in a working cart.

## Public API (`index.ts`)

Every service takes a store-scoped `ScopedClient` first; the contract types are re-exported next to them.

| Area      | Exports                                                                                                                                                                                        | Who else calls it                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Campaigns | `listCampaigns` `getCampaign` `createCampaign` `updateCampaign` `deleteCampaign` `launchCampaign` `endCampaign` `toCampaign` `normaliseCampaignInput` + the enums in `types.ts`                | —                                               |
| Reports   | `attributionReport` `abandonedCartReport` `promotionReport`                                                                                                                                    | —                                               |
| Feeds     | feed CRUD, `publishFeed`, `listFeedItems`; the pipeline steps `buildFeedItems` / `validateItems` / `renderFeed`; the `FeedStorage` seam (`setFeedStorage`, `FilesystemFeedStorage`, `feedKey`) | `apps/feeds` shares the key convention only     |
| Segments  | segment + template CRUD, `previewSegment`, `materializeSegment`; the grammar (`parseSegmentRules`, `SEGMENT_FIELDS`, `SEGMENT_RULES_SCHEMA`); `compileSegmentRules` / `segmentQuery`           | window 16, the admin rule builder (the schema)  |
| Sync      | `segmentSyncPayload`, `emailHash`                                                                                                                                                              | window 16                                       |
| Recovery  | `consumeAbandonedCarts`, `reconcileRecoveries`, `validateRecoveryToken`, `listRecoveries`, `getRecoveryByCart`, the token helpers, `RECOVERY_UTM_SOURCE`                                       | window 1 (the Store API route), windows 3/10/16 |
| HTTP      | `marketingAdminRouter()` — every Admin API route of the module                                                                                                                                 | window 1 mounts it                              |

Nothing outside this folder may import from any other file here.

## Routes and permissions

Read from each operation's `x-permission` in `admin-api.yaml` at runtime — never hard-coded here.

| Operation                                              | Method + path                                            | Permission    |
| ------------------------------------------------------ | -------------------------------------------------------- | ------------- |
| `listCampaigns` / `getCampaign`                        | `GET /admin/stores/{storeId}/marketing/campaigns[/{id}]` | `store_staff` |
| `createCampaign` / `updateCampaign` / `deleteCampaign` | `POST` / `PATCH` / `DELETE` on the same paths            | `store_admin` |
| `launchCampaign` / `endCampaign`                       | `POST …/campaigns/{id}/launch` · `…/end`                 | `store_admin` |
| `getAttributionReport`                                 | `GET …/marketing/reports/attribution`                    | `viewer`      |
| `getAbandonedCartReport`                               | `GET …/marketing/reports/abandoned-carts`                | `viewer`      |
| `getPromotionReport`                                   | `GET …/marketing/reports/promotions`                     | `viewer`      |
| feeds, segments, templates                             | see `routes.ts`; each reads its own `x-permission`       | per the spec  |

`viewer` is the spec's "any relation on the store" convention (Integration 1 decision), so an HQ analyst reads the
report next to store staff without gaining access to the campaign rows.

### Mounting

`src/http` and `src/server.ts` belong to window 1, so this router is **not** mounted by the module itself: it is
exported from `index.ts` and mounted by one `routers.push(...)` line in `src/http/module-routers.ts` (#181,
landed). `routes.test.ts` still mounts it on a bare Express app behind the real middleware chain, so the contract
shapes are proven without booting the core.

### `getPromotionReport` — marketing's route, window 9's numbers

`GET …/marketing/reports/promotions` (`viewer`) is a thin route: `promotion-report.ts` validates the window
exactly as the other two reports do (same 400 for a missing or inverted window) and hands it to window 9's
`promotionReportData` through the promotions module's public API. The figures — uses, discount given and revenue
per code over non-cancelled orders — and their caveats (an order with two codes counts under both) are theirs and
documented in `src/modules/promotions/README.md`. Found missing in the 2.6 docs pass; built as its own follow-up.

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

### The report SQL, and why it is shaped this way

Two queries over one CTE (`PLACED_ORDERS` in `reports.ts`: store, currency, `[from, to)`, `status <> 'cancelled'`):

1. **Attributed** — `placed JOIN attribution ON order_id AND touch = $touch`, grouped by
   `(utm_source, utm_medium, utm_campaign, campaign_id)`. The campaign comes from a `LEFT JOIN LATERAL` that
   picks the oldest campaign of the store whose `lower(utm_campaign)` matches; `campaign_id` is functionally
   determined by `utm_campaign`, so adding it to `GROUP BY` never splits a group.
2. **Direct** — the same CTE `WHERE NOT EXISTS` an attribution row for that touch, appended as one `direct` item.

Choices that are decisions rather than accidents:

- **One touch per report.** `first` and `last` are separate reports, never blended — a blended model is an
  opinion, and two honest numbers beat one averaged one. Each order has at most one row per touch, so no order
  is counted twice within a report.
- **Revenue is `order.total_minor`** — what the customer paid, tax and shipping included, the same number the
  order list shows. The abandoned-cart report uses the same total and the same cancelled-order rule, so an
  order is never revenue in one marketing report and not in the other.
- **Sums are `::text` in SQL and `Number()` in TypeScript**: node-postgres returns `bigint`/`sum()` as strings.
- **Ordering is total**: revenue desc, count desc, source asc NULLS LAST — the same input always renders the same
  table, which is what lets a test compare whole reports.

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

**Formats.** One renderer per channel, chosen by `channel`; the extension and content type come from
`FEED_EXTENSION` / `FEED_CONTENT_TYPE`, never from the caller.

| Channel               | File                                               | Why that format                                               |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `google_merchant`     | RSS 2.0 + the `g:` namespace, `.xml`               | Merchant Center's scheduled-fetch format; attributes as `g:*` |
| `meta`                | CSV with Meta's catalogue column names, `.csv`     | the Commerce Manager data-feed format; quoted per RFC 4180    |
| `tiktok`, `pinterest` | storable, **not renderable** — publishing is a 409 | no file is better than a file the channel would half-accept   |

Stored under `<store_code>/<feed_id>.<ext>` — the one convention `apps/feeds` shares with this module.

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

### `SegmentRules` in the contract (#239, landed in contracts-v0.4.4)

Until 0.4.4 the Admin API described `SegmentRules` as a flat, open bag ("unknown keys are kept"). #239 replaced it
with the closed grammar above, so the spec layer (`validateBody`) now refuses a bad rule **before** this module's
parser sees it; `routes.test.ts` asserts that spec-layer 400, and the parser tests still cover the grammar on its
own for window 16 and jobs that do not go through HTTP.

## Abandoned-cart recovery (2.4, #148)

Four moving parts, none of which sends anything: window 1 emits `cart.abandoned`, this module turns it into a
recovery record with a link, window 16 sends the email, and the customer's click comes back through a Store API
route that window 1 mounts.

```
window 1 job → cart.abandoned → consumeAbandonedCarts  → cart_recovery (+ token)
                                                       ↘ window 16 sends the link
customer clicks → POST /store/cart-recovery/{token} → validateRecoveryToken → the cart, reactivated
order placed   → reconcileRecoveries → status `recovered` → the rate report
```

### The consumer

Outbox polling per store, the shape window 9's search sync uses: read `cart.abandoned` rows with `seq > cursor`,
create a record each, advance the cursor **in the same transaction as the inserts**. The cursor lives in
`marketing_cursor` (one row per store and consumer) — window 9 could park theirs in Algolia's settings because
the database was frozen; marketing has nowhere to hide one, and a position that is not durable means re-reading
the whole outbox after every restart.

**Idempotency is the schema's job, not the consumer's.** `UNIQUE (cart_id)` on `cart_recovery` makes a
re-delivered or replayed event a no-op, so "one recovery record per cart" (#148) holds even if the cursor is
rewound from a restore. The tests rewind it on purpose and check that the _original_ token still works — a
replay must never invalidate a link already sitting in someone's inbox.

A cart abandoned, recovered and abandoned again keeps its first record: the rate counts carts, not episodes,
and minting a second token would leave the first one live.

### Tokens

32 random bytes, base64url. **Only `sha256(token)` is stored** — the same treatment as `store_api_key.key_hash` —
and the plaintext exists exactly once, in the `tokens` map `consumeAbandonedCarts` returns, for whoever sends the
link. Single use (`redeemed_at`), 7-day expiry (`token_expires_at`).

**The token carries nothing**: no cart id, customer id or email is encoded in it. That is what makes a link safe
to put in an email, a referrer header or a support ticket — and it is also _why_ redemption has to be a server
round trip, which is why the Store API route exists rather than an exported function the storefront could call
(manager decision 2026-09-19; the storefront only speaks the publishable-key Store API).

**Unknown, expired and already-redeemed all answer the same 404.** A recovery link is a bearer credential;
distinguishing the cases would let someone holding a guessed token learn whether it ever existed. A cart that
was already ordered answers **409** instead — that customer is confused rather than lost, the storefront should
say "you already placed this order", and it leaks nothing because the caller already proved they hold a valid
token.

Single use is enforced by `UPDATE … WHERE redeemed_at IS NULL` returning no row, not by the read above it: two
clicks arriving together must not both succeed, and check-then-write would let them.

### Recovery detection and the rate

`reconcileRecoveries` reads `cart.order_id`, which window 1's placement sets — marketing never decides what an
order is. It is idempotent on the target state, so a cart counts **once** however often it runs.

The report counts over `cart_recovery` rows (one per cart, so no double counting) in the store's default
currency, with `recovered_value` taken from the **order** total rather than the cart's: what the customer
actually paid after coming back. `redeemed_count` sits between abandoned and recovered because "sent vs opened
vs bought" is the only way to tell a bad link from a bad offer, and window 16 owns sending. No carts abandoned
is a rate of `0`, not a division by zero.

### Attribution

The link carries `utm_source=abandoned_cart`; the storefront captures it into `cart.metadata.attribution` as it
already does, and window 1's placement writes the `attribution` row. **This module writes no attribution** — it
reads it, which is what keeps the 2.1 report and the recovery rate telling the same story about the same order.

### Around it

| Piece                                                       | Owner            | State                             |
| ----------------------------------------------------------- | ---------------- | --------------------------------- |
| `cart_recovery` + `marketing_cursor` migration              | main window      | #244 — landed in contracts-v0.4.5 |
| `reports/abandoned-carts` + the Store API recover operation | main window      | #245 — landed in contracts-v0.4.5 |
| Mounting `POST /store/cart-recovery/{token}`                | window 1         | #246 — done                       |
| The storefront page at `/cart/recover/{token}`              | windows 3 and 10 | REQUEST #247 — open               |
| Sending the email                                           | window 16        | Phase 4                           |

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

`marketing.e2e.test.ts` is the one test to read first: a single customer's attributed order goes through the
campaign report, a feed publish and a segment materialisation on one database, and the same run is the **PII
sweep** — every outbox payload and audit row the flow wrote, and every console call it made, is searched for the
customer's email, name, address and phone (and for PII-shaped keys). A static check next to it fails if a log
call ever appears in the module's sources (recursively). The other suites are per area: `marketing` (campaigns + report),
`feeds` / `feed-render`, `segments` / `segment-rules`, `recovery`, `routes` (HTTP + contract shapes).

Tests create their own throwaway database through `@platform/db/testing` (never the shared docker stack) and seed
it; the route tests use dev tokens (`CORE_DEV_TOKENS=1`) for the seeded staff subjects, exactly as
`test/admin-api.test.ts` does.

## Next in this folder

Phase 2 is complete. Phase 3, when the manager opens it: the
referral programme (`/r/{code}` with window 3, rewards through promotions, `referral.converted`), reviews
(requested after `shipment.delivered`, moderation, the PDP display contract), the consent centre (opt-in rates,
EU double opt-in, audit export), and the HQ marketing dashboard (per-brand comparison, shared templates, budgets
per legal entity), and a cart-module function for the recovery `cart.status` reactivation. The report's single-currency limitation is revisited at Integration 2.
