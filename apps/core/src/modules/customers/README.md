# customers

Customer self-service on the Store API (#303, #470): the store-level `customer` row of a signed-in shopper
(`packages/db` migration 0005). Owner: window 13 (customers) since Phase 3 (docs/ownership.md; built by window 1
until #414). The Admin API customer operations live in `admin.ts` / `gdpr.ts` (below); their routes are in
`src/http/admin-routes.ts`.

There is **no "register first" step**. Every `/store/customers*` route resolves the customer from the verified
customers-realm token, and creates the row when it does not exist yet. The store comes from the publishable key;
the subject and the email come from the **token only** — never from a request body.

## Public API (`index.ts`)

| Function                                                                | Route                                                                     | What it does                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `resolveCustomer(client, scope, identity)`                              | `GET /store/customers/me` (and every `/me`)                               | the customer of the token in this store, created on first use (`marketing_consent` false)                                       |
| `registerCustomer(client, scope, identity, input)`                      | `POST /store/customers`                                                   | resolve-or-provision, then names and consent; `{ customer, created }` — the route answers 201 or 200                            |
| `updateCustomer(client, scope, identity, patch)`                        | `PATCH /store/customers/me`                                               | resolve-or-provision, then names, phone and consent; an empty string clears a column                                            |
| `listCustomerAddresses(client, scope, identity)`                        | `GET /store/customers/me/addresses`                                       | the customer's addresses, default shipping first, then oldest first                                                             |
| `addCustomerAddress(client, scope, identity, input)`                    | `POST /store/customers/me/addresses`                                      | validates, decides the default flags under a lock on the customer row, inserts (201)                                            |
| `updateCustomerAddress(client, scope, identity, addressId, patch)`      | `PATCH /store/customers/me/addresses/{addressId}` (#470, Store API 0.5.6) | a present field replaces, `null` clears a nullable one, a default flag moves under the same lock; 404 for another customer's id |
| `deleteCustomerAddress(client, scope, identity, addressId)`             | `DELETE /store/customers/me/addresses/{addressId}` (200 `{ items }`)      | deletes; a default it held moves to the oldest remaining address; answers the remaining list                                    |
| `requestCustomerExport(client, storeId, customerId, actor)` (`gdpr.ts`) | `POST /store/customers/me/export` (202) and Admin `exportCustomer`        | one `customer.export_requested` v2 per call: `requested_by` + `requested_by_type` (`customer` / `staff`)                        |
| `eraseMe(client, scope, identity)` (`gdpr.ts`)                          | `DELETE /store/customers/me` (202)                                        | the customer erases their own row in this store (see "Erasure and export"); replay = no-op                                      |
| `findCustomerForSubject(client, storeId, subject)`                      | `GET /store/orders/{orderId}`                                             | read-only `{ id, status }` or null — for routes that must not create a customer                                                 |
| `customerEmailHash(email)`                                              | —                                                                         | `email_hash` of the events contract (sha256 of the trimmed, lowercased email)                                                   |

`identity` is `{ subject, email?, emailVerified }` from a verified token (`src/http/customer-routes.ts` builds it;
`emailVerified` is true only for an explicit `email_verified: true` claim, absent = false). `scope` is
`{ organizationId, storeId, requestId }` from the tenant context. `client` is the store-scoped client: RLS keeps
every read and write inside the store of the key.

`GET /store/customers/me/orders` is the orders module's `listStoreOrders` (the route calls it with the resolved
customer id). An invalid `page` / `limit` there is a 400 `validation_error` — the house rule for an invalid
query (as on `listProducts`), **not clamped**. Store API 0.5.1 does not document that 400 on `listMyOrders` yet:
a recorded deviation on #303, added to the contract at the next landing. `updateMe` and the address operations
are `updateCustomer`, `listCustomerAddresses` and `addCustomerAddress` (part B).

## Rules

- **Provisioned once.** `INSERT … ON CONFLICT DO NOTHING`, then select: of several first requests of one subject
  exactly one creates the row and writes `customer.created` and the audit row; the others find it.
- **Email collision** — the token's email is already on a row of this store (a guest row, or another identity's):
  - the token's email is **verified** and the row has **no subject** → the row is adopted: it gets the subject,
    becomes `registered`, one `customer.updated` (`['keycloak_subject', 'status']`) and one audit row
    (`customer.link`);
  - anything else → 409 `conflict`, nothing written. An unverified email never adopts: the customers realm has
    open registration, so anyone can hold a token with any unverified address.
  - **several rows whose email differs only by letter case** (the table's unique index is case-sensitive, the
    lookup is not) → 409 as well, even for a verified token: there is no guessing which row is the person.
- **Disabled and erased** customers are a 401 on every route and are never provisioned again — also when the
  row has no subject yet and a verified token arrives for its email.
- **A token without an email** reads an existing customer; it cannot create one (401, `reason: no_email`).
- **`registerCustomer`'s body `email`** is a confirmation, not an input: it must equal the token's email
  (trimmed, case-insensitive), otherwise 400 `validation_error` and nothing is written.
- **Consent** is recorded only when the answer changes (`consent.marketing_email = { granted, at, source:
'storefront' }`). A `false` on a customer who was never asked records nothing, so "never asked" stays different
  from "opted out" — the marketing module's re-consent segments depend on that difference.
- The email is stored trimmed and lowercased, and it is **not rewritten** when the customer later changes their
  email at Keycloak (see "Known gaps"). Wherever the row's email meets an order's email it is compared
  case-insensitively (`lower()` on both sides) — an order keeps the checkout email as typed.
- **Body rules come after the token**: every body rule of `registerCustomer` is checked after authentication.
  The one exception is JSON that does not parse — the body parser runs before the handler, so that is a 400
  for anyone. The parser is on the three routes that read a body (`POST /store/customers`,
  `PATCH /store/customers/me`, `POST /store/customers/me/addresses`), never on the prefix: a GET that carries a
  body is not parsed at all.
- **Free text** (names, phone, every address field) is trimmed; an empty string becomes NULL — that is how a
  phone or a name is cleared on `updateMe`, the contract has no other way; a required address field that is
  blank is a 400 naming the field; anything longer than 200 characters is a 400 naming the field (the contract
  has no `maxLength`, the columns are unbounded).
- **Default address.** The customer's FIRST address is the default for shipping and billing; a later one is
  neither — unless the body says so: `is_default_shipping` / `is_default_billing` (optional booleans, contracts
  0.4.9; the core accepts the field names already) — `true` makes the new row the default and clears the flag
  on the customer's other rows; an explicit `false` is ignored on the first address (the first is ALWAYS the
  default for both, so a customer with addresses always has one). Decided under a lock on the
  customer row (`FOR NO KEY UPDATE`) and applied as clear-then-set in the same transaction, because
  `customer_address` has no unique index on the flags. Window 17's segments read `country` from the default
  shipping address, so it moves only when the customer asks.
- **At most 50 addresses** per customer (`ADDRESS_LIMIT`): the list is unpaginated; a further one is a 400
  `validation_error` with `addresses: "at most 50"`.
- **Editing and removing an address (#470, Store API 0.5.6).** `updateMyAddress` is a partial patch like
  `updateMe`: a present field replaces the stored one (trimmed, 200 characters, the country alpha-2), `null`
  clears `company` / `line2` / `region` / `phone`, a required field cannot be blanked or nulled (400 naming it).
  A default flag `true` moves that default to this address (clear-then-set under the customer-row lock, as on
  add); `false` hands the flag to the customer's OLDEST other address — and is ignored on the only address, so a
  customer with addresses always has a default. A patch that changes nothing writes nothing. `deleteMyAddress`
  (200 `{ items }`, the remaining addresses in list order — no 204 in the Store API, and the page needs to see where a
  default went) applies the same heir rule to whatever defaults the deleted address held. Another customer's address id
  and an unknown id are the same 404 (the lookup is on both ids, under RLS). One audit row per change
  (`customer_address.update` with the changed column NAMES and the flags, `customer_address.delete` with which
  defaults moved to which address — never a line, a city or a phone) and one `customer.updated` (`['addresses']`).
- **Recorded deviation on #303:** `updateMe` answers 400 on a wrong type or a non-object body, and
  `listMyOrders` on an invalid `page` / `limit`; Store API 0.5.1 documents neither 400 — contracts 0.4.9 adds
  both. `listMyAddresses` has no 400 (no query, no body).
- **Undefined operations are a 404.** Every operation of `/store/customers` is answered here, so an unknown
  path or a method the contract does not give a path (`PUT /store/customers/me`) is 404 `not_found`
  ("… is not implemented") from a terminal handler — with or without a bearer, never the fallback proxy. No
  405, no new error code.
- **The customer on carts and orders (#310):** `createCart` and `completeCart` accept the same token and
  resolve-or-provision the customer the same way; see the checkout README "Customer link at placement".

## Admin API (#414, Admin API 0.4.11) — `admin.ts`, `gdpr.ts`

Store-scoped tenant client (RLS) for everything; the routes live in `src/http/admin-routes.ts`, permissions from
the spec. Every mutation writes its audit row and its outbox event in the same transaction; neither ever carries an
email, a name, a phone or an address (`email_hash` and field names only).

| Operation               | Permission             | Function                                     | Notes                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listCustomers`         | `support` on the store | `adminListCustomers(client, storeId, query)` | `q` = case-insensitive substring of email / first / last name (LIKE wildcards literal); `group_id`; sort `created_at` (default, desc) / `email` / `last_name` (nulls last)                                                                                                |
| `getCustomer`           | `support`              | `adminGetCustomer`                           | 404 for unknown and for another store's customer (indistinguishable under RLS); erased rows are readable                                                                                                                                                                  |
| `updateCustomer`        | `support`              | `adminUpdateCustomer`                        | names / phone (`''` clears), `customer_group_id` (a group of the SAME store or null, else 400), `status` registered ↔ disabled (a guest has no account: 400); erased → 404; a patch that changes nothing writes nothing; one `customer.updated` (sorted `changed_fields`) |
| `listCustomerAddresses` | `support`              | `adminListCustomerAddresses`                 | defaults first; 404 like `getCustomer`                                                                                                                                                                                                                                    |
| `listCustomerGroups`    | `viewer`               | `listCustomerGroups`                         | the store's groups by code. Groups are created by the seed / migrations; there is no create or update operation in the spec — assignment goes through `updateCustomer`                                                                                                    |
| `eraseCustomer`         | `store_admin`          | `eraseCustomer` (`gdpr.ts`)                  | 202, no body; see below                                                                                                                                                                                                                                                   |
| `exportCustomer`        | `store_admin`          | `requestCustomerExport` (`gdpr.ts`)          | 202, one `customer.export_requested` per request; the bundle itself is `buildCustomerExport`; see below                                                                                                                                                                   |

### Erasure and export (GDPR; manager decisions 2026-10-08)

**Erasure** is synchronous (one transaction) although the contract says "scheduled": the 202 answers both a fresh
erasure and the replay on an already erased customer (no-op: nothing written, no second event). Two entry points,
one shape: the Admin API `eraseCustomer` (store_admin) and the customer's own `DELETE /store/customers/me`
(`eraseMe`, #470 — actor = the customer; a subject with NO row in this store is a 202 no-op, nothing is
provisioned — #487 review: provisioning first would put a `customer.created` with the real email hash into the
outbox for a person who asked to be deleted; `POST /me/export` follows the same rule). In that transaction:

- `status` → `erased`; `email` → **`erased+<customer_id>@invalid`** (the column is NOT NULL and unique per store;
  `.invalid` is reserved by RFC 2606, so the placeholder can never receive mail); `first_name`, `last_name`,
  `phone` → null; `consent` and `metadata` → `{}`. The id, store, group and timestamps stay.
- **`keycloak_subject` STAYS — the erasure tombstone** (manager decision 2026-10-18, #482, on the owner's lawyer
  list; until then it was nulled). It is an opaque identifier of the identity provider, not personal data, and it
  is what keeps the same login a 401 on every route afterwards and a repeated `DELETE /me` a 202 no-op: with the
  subject nulled and the email replaced, nothing would find the erased row and the next `/me` would silently
  provision a fresh account for the person who just asked to be deleted. The Keycloak user itself (the PII outside
  Postgres) is deleted by a separate job on `customer.erased` (REQUEST #483); the tombstone is meaningless once
  that has happened — until #483 lands the tombstone is pseudonymous (an id that the identity provider can still
  resolve to a person), not anonymous; after it, it resolves to nothing. Self-service deletion erases ONLY the
  requesting store's row; whether it should span every brand of the organization is the owner's open decision
  (#473 picks it up).
- **Lock before judging the status (#487 review).** `resolveIn` reads the customer's row `FOR NO KEY UPDATE`, so
  every `/me` write — profile, address add / update / delete, export request, the consent writes of #471 —
  judges `status` on the row as it is after a concurrent erase or disable has committed, and writes under that
  lock. A `POST /me/addresses` that waits behind `DELETE /me` therefore answers 401 and never puts an address
  onto the erased row; one that held the lock first wins, and the erasure then deletes what it wrote (tested
  both ways).
- every `customer_address` row of the customer is deleted;
- `identity_id` → null, and the organization-level `customer_identity` row is deleted when nothing references it
  any more (another store's customer of the same person, or a merged identity, keeps it — tried under a
  savepoint, a foreign-key refusal means "keep");
- **orders are kept unchanged**, linked by `customer_id` only. Basis: invoices and transaction records are
  retained under the legal-obligation exception (GDPR art. 17(3)(b)) — manager decision A, on the owner's
  lawyer-review list; if the review says otherwise it becomes a follow-up (scrub the order email / shipping
  address), not a redo;
- one audit row `customer.erase` (`addresses_deleted`, `identity_unlinked`, `identity_deleted` — no personal
  data) and ONE `customer.erased` outbox row; consumers (marketing reviews / referrals, search, BI) must delete
  their copies on it — the core does not reach into their tables.

An erased customer stays listable and readable by support (status `erased`, the placeholder email, null names), is
not updatable (404) and not exportable (404).

**Export.** `buildCustomerExport(client, storeId, customerId)` returns the bundle `customer-export/v1`:
`{ format, generated_at, store_id, customer: { id, email, first_name, last_name, phone, status,
customer_group_id, created_at }, addresses: [...], consent: {...}, orders: [{ id, display_id, status,
payment_status, fulfillment_status, email, currency, shipping_address, billing_address, subtotal_minor,
discount_minor, shipping_minor, tax_minor, total_minor, placed_at, lines: [{ sku, title, variant_title,
quantity, unit_price_minor, discount_minor, tax_minor, total_minor }] }] }` — that store, that customer only
(RLS plus explicit predicates; the test exports with two stores and two customers). Unknown, another store's or
erased → 404. `exportCustomer` (202) and the customer's own `POST /store/customers/me/export` (202, #470) write
one `customer.export_requested` **v2** row per request (no dedupe; ids only): `requested_by` is the staff user id
or the customer id, `requested_by_type` says which (`staff` / `customer`; events contract #482 — v1 stays in the
registry, nothing consumes the topic before #472). That is the hand-over to the delivery job (#472), which calls
`buildCustomerExport` and tells the customer by email.

## Known gaps

- **Stale email after a change at Keycloak.** The row keeps the email it was created (or adopted) with. Until an
  email-change sync exists (Phase 3, window 13), `GET /store/customers/me` shows the old address, the
  `email_hash` in events is the old one, and `registerCustomer` compares its body against the token's NEW email.
  Order reads are not affected: they match on the token's verified email, never on the row's.
- **A linked cart is readable by anyone holding the cart id** (cart ids are the capability today; Phase 3), and
  older guest orders are not back-filled: the read-time match on a verified token email covers them.

## Events and audit

One transaction per use case; whatever happened to the row yields **one** event and **one** audit row, or none
when nothing changed.

| Event              | When                                                                          | Payload                                                                                        |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `customer.created` | the row was created (names/consent included)                                  | `customer_id`, `identity_id`, `email_hash`, `status`, `customer_group_id`, `marketing_consent` |
| `customer.updated` | adoption; names / phone / consent changed; an address added (`['addresses']`) | the same + `changed_fields` (column names)                                                     |

Audit actions: `customer.create`, `customer.link`, `customer.update`, `customer_address.create` (entity
`customer_address`, `after` = customer id and the two default flags), `customer_address.update` (+ the changed
column names), `customer_address.delete` (which defaults moved, to which address), `customer.export_request`
and `customer.erase`; actor = the customer (`actor_type` `customer`, `actor_id` = the customer id). Neither an event nor an audit row carries an email, a name, a line, a
city, a postal code, a phone or the Keycloak subject, and nothing in this module logs (tested).

## Storefront (window 13's part of `apps/storefront-starter`)

The account page (`src/app/[locale]/(account)/account/page.tsx`, `force-dynamic`, nothing personal in
`searchParams`) renders the address book with an edit form and a remove button per address
(`src/components/account-address-forms.tsx`) and a **Privacy** section (`account-privacy.tsx`): "Download my data"
(`requestMyExport`) and "Delete my account" (typed confirmation `DELETE`, then `deleteMe`; the action then clears
the LOCAL session cookie only and the customer lands on `/account/deleted`, which offers the Keycloak SSO sign-out
as a button — a redirect cannot POST to `/auth/sign-out`, and Keycloak's session is the customer's to end; the
erased account answers 401 to that login either way). Copy lives in the `account.*` message catalogs (en-GB,
de-DE): the starter's i18n test refuses literal copy in `src/components`. The server actions
live in the route group (`account/actions.ts`) and call the Store API client's generic `request` — the client's
typed methods are window 3's file. Pure rules (`account.config.ts`): the edit form sends every field, blank
optional ones as `null`; a default checkbox is sent only as `true` (a default is moved by ticking it on another
address, never "given up"). Unit test: `account/account.test.ts` (collected once REQUEST #484 widens the include).

## Tests

`customers.test.ts` (database, as `platform_app`): provisioning once — also under eight concurrent first
requests —, store isolation, register (create / update / no-op / email mismatch), the collision rule including
two identities racing for one guest row, disabled / erased, `updateCustomer` (clear / no-op / over-long), addresses
(first = default, explicit flags, six concurrent first addresses → one default each, validation, the cap, store
isolation), address edit / delete (#470: replace / clear / cannot blank, no-op, flag moves and the oldest-heir
rule, the only-address `false`, 404 for another customer / store / unknown id), `eraseMe` and the tombstone
(replay no-op, the same subject 401 everywhere with no fresh row — for the admin erase too, adopt-then-erase),
and the no-PII check over the outbox, the audit log and the console. HTTP behaviour, the verifier seam, the
self-service acceptance of #470 (own addresses only, brand-b key + brand-a token = 401, `DELETE /me` leaves no
PII and keeps the order, export v2 by the customer) and the live Keycloak test: `test/customers-api.test.ts`.
