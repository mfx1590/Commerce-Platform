# CDP tracking plan

`tracking-plan.json` is the contract between our event bus and the CDP (RudderStack first): which event topics
become a CDP call, what each one carries, how an identity is resolved, and — just as deliberately — which
topics do **not** go to the CDP and why. Owner: window 16 (engagement), task #554. The mapper that executes it
is `apps/engagement/src/cdp/`; the bus contract itself is `packages/events` and ADR 0003.

It is a reviewed artefact, not documentation written after the fact: adding a topic here is the decision to
send a third party something about our customers, and the reason column is the record of why that was thought
acceptable.

## The plan at a glance

- **9 topics mapped**: `customer.created` / `customer.updated` → `identify`, `customer.erased` → `suppress`,
  and `order.placed`, `order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped`,
  `return.requested` → `track`.
- **29 topics unmapped**, each with its reason. A test asserts the two lists together cover every topic in
  `EVENT_TOPICS` exactly once, so a new event in the contract cannot be silently forgotten or silently sent: a
  new topic fails the suite until someone writes down which it is.

## Rules the plan encodes

**No PII leaves us.** Events carry none by contract (ADR 0003 item 5) — ids, integer minor-unit amounts with
their currency, countries, counts and `email_hash`. The plan adds only the store code. A test walks every
mapped payload for e-mail, name, address and phone shapes.

Two properties are dropped although the payload has them, for the same reason the ops alerts drop one
(#553): `shipment.shipped.tracking_number`, which identifies a parcel at a carrier and buys an audience
nothing, and `return.requested.reason`, which is free text a customer or an agent typed. `order.placed` line
items are reduced to counts rather than forwarding each title and SKU — every property sent is one more thing
to justify.

**Consent gates everything except an erasure.** Read-only, from the `customer.consent` projection
(`packages/db` 0005, maintained by the core's consent ledger alongside 0194), through a tenant client scoped to
the event's own store, and **evaluated at processing time** — manager ruling, 2026-10-23. Never the
`customer_consent` ledger rows, never a write, never an API hop. Purpose: `marketing_email`, the only one the
0194 CHECK allows.

**Consent mode (#576, owner decision 2026-10-23).** The two questions this section used to leave open — does
analytics tracking need a marketing consent, and may a guest be tracked pseudonymously — were answered:
**both are allowed.** The owner's position is that counting our own commerce events is analytics rather than
marketing. Region rules will be applied after the legal review, and the switch is built so that applying one
is a config change rather than a code change.

| Mode                      | `track` / `identify`                          | A guest (no `customer_id`)       |
| ------------------------- | --------------------------------------------- | -------------------------------- |
| **`analytics`** (default) | run without `marketing_email`                 | tracked under their `email_hash` |
| `strict`                  | need granted `marketing_email` for that store | dropped                          |

**The mode resolves PER STORE.** `ENGAGEMENT_CDP_CONSENT_MODE` is the global default (`analytics`), and
`ENGAGEMENT_CDP_CONSENT_MODE_<STORE_CODE>` overrides it for one store — the `NOTIFICATIONS_<STORE>_<FIELD>`
shape, with the code uppercased and non-alphanumerics underscored. Each brand is one market today
(A=EU, B=UK, C=US), so **making one region strict is one line**:

```
ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A=strict
```

It is resolved per event from the store the event names, and the effective mode is on every per-event log
line (`consent_mode`), so "why is the CDP empty for brand A" is answerable from the log. An unknown value
fails the boot rather than falling back to the open mode: a typo like `strcit` must never silently become
`analytics`.

Two things `analytics` does **not** relax, because neither is about consent:

- an **erased** customer is never sent, in either mode. The erasure already told every consumer to delete its
  copies, and tracking that person again would undo it;
- a vanished order or customer row is still reported as such rather than guessed at.

And one thing it does not change at all: **CRM sync (#555) stays consent-gated in every mode.** Putting a name
and an e-mail into a third-party CRM is a different act from counting an order, and a test asserts the CDP mode
cannot reach it.

`customer.erased` is the one call that is **not** consent-gated, in either mode: a suppression must go out
precisely for the customer who has withdrawn everything. It carries **both** ids when both are known, so a
profile keyed by the hash is suppressed alongside one keyed by our `customer_id`.

**Two erasure gaps, both known and both recorded rather than hidden:**

1. **`customer.erased` v1 carries no `email_hash`** — and the customer row is deleted by then, so the value
   cannot be looked up afterwards either. That did not matter while guests were never tracked; it matters now
   that `analytics` creates hash-keyed guest profiles, because an erasure would suppress the `customer_id`
   profile and leave the same person's earlier hash-keyed one. **CONTRACT CHANGE #580** adds `email_hash` to a
   new v2 (the core computes it from the e-mail before the delete); the suppression here already sends the hash
   **when the payload carries one**, so it starts working the day v2 lands, with no change on this side.
2. **A guest who never registers produces no `customer.erased` at all.** There is no customer row, so nothing
   triggers a suppression of their hash-keyed profile. Closing that needs a guest-erasure path — an erasure
   request keyed by e-mail with no customer behind it — which is a later wave and a wider decision than a
   schema.

**An identity we cannot resolve means nothing is sent.** `customer_id` when known, otherwise `email_hash`. The
five order-scoped topics (`order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped`,
`return.requested`) carry neither, so the identity is read from the `order` row through the same store-scoped
client, in the same query as the consent projection — one read per event, not a second source of truth. In **`analytics`** mode a guest is tracked under their `email_hash`; in **`strict`** mode they are dropped.

**A known asymmetry, worth knowing before reading the data.** Of the six mapped commerce topics only
`order.placed` carries an `email_hash`; `order.cancelled`, `payment.captured`, `refund.issued`,
`shipment.shipped` and `return.requested` carry neither a hash nor a `customer_id`, so for a GUEST there is no
identity available and the event is dropped even in `analytics` mode. The consequence: a guest's
_Order Completed_ reaches the CDP while their later _Order Shipped_ does not. Closing it by hashing the order row's raw e-mail inside the CDP
path was **considered and REFUSED** (manager ruling 2026-10-24: this service reads no raw e-mail, anywhere) —
so the asymmetry stands, recorded here rather than closed by widening what we read. If guest analytics ever
matters, the way in is a CONTRACT CHANGE adding `email_hash` to those five topics, which the manager has
recorded as a later wave. A test pins the behaviour in both directions.

## Changing it

1. Edit `tracking-plan.json` — a mapped topic needs its `call`, its properties and `consent_gated`; an unmapped
   one needs a reason a reader can disagree with.
2. Add or change the mapping in `apps/engagement/src/cdp/` and its fixture test. The tests fail until the plan
   and the mapper agree in both directions.
3. `pnpm --filter @platform/engagement exec vitest run`, then the README and CHANGELOG there.

Mapping any of window 17's marketing topics (`cart.abandoned`, `attribution.recorded`, …) is a REQUEST to
window 17 first: those drive their own flows and double-sending them would double-count an audience.
