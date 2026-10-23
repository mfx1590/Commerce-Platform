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
0194 CHECK allows; a CDP-specific purpose would be a CONTRACT CHANGE to window 13's table, to be filed rather
than invented.

`customer.created` and `customer.updated` carry a `marketing_consent` field in their payload and **the mapper
ignores it on purpose.** A decision here can therefore contradict the event's own snapshot — the event says
granted, the customer revoked in between, nothing is sent. That is the ruling working, not a bug; please do not
"fix" it by reading the payload.

`customer.erased` is the one call that is **not** consent-gated: a suppression must go out precisely for the
customer who has withdrawn everything.

**An identity we cannot resolve means nothing is sent.** `customer_id` when known, otherwise `email_hash`. The
five order-scoped topics (`order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped`,
`return.requested`) carry neither, so the identity is read from the `order` row through the same store-scoped
client, in the same query as the consent projection — one read per event, not a second source of truth. An
event with no resolvable customer (a guest order carrying only `email_hash`) is **dropped**: there is no
consent row to check, and tracking it pseudonymously would be a decision nobody made. This does mean guest
orders do not reach the CDP; it is written down here so it is a known trade and not a surprise.

## Changing it

1. Edit `tracking-plan.json` — a mapped topic needs its `call`, its properties and `consent_gated`; an unmapped
   one needs a reason a reader can disagree with.
2. Add or change the mapping in `apps/engagement/src/cdp/` and its fixture test. The tests fail until the plan
   and the mapper agree in both directions.
3. `pnpm --filter @platform/engagement exec vitest run`, then the README and CHANGELOG there.

Mapping any of window 17's marketing topics (`cart.abandoned`, `attribution.recorded`, …) is a REQUEST to
window 17 first: those drive their own flows and double-sending them would double-count an audience.
