# customers

Customer self-service on the Store API (#303): the store-level `customer` row of a signed-in shopper
(`packages/db` migration 0005). Owner: window 1 (ruling 2026-10-02). The Admin API customer routes are not here.

There is **no "register first" step**. Every `/store/customers*` route resolves the customer from the verified
customers-realm token, and creates the row when it does not exist yet. The store comes from the publishable key;
the subject and the email come from the **token only** — never from a request body.

## Public API (`index.ts`)

| Function                                             | Route                                       | What it does                                                                                         |
| ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `resolveCustomer(client, scope, identity)`           | `GET /store/customers/me` (and every `/me`) | the customer of the token in this store, created on first use (`marketing_consent` false)            |
| `registerCustomer(client, scope, identity, input)`   | `POST /store/customers`                     | resolve-or-provision, then names and consent; `{ customer, created }` — the route answers 201 or 200 |
| `updateCustomer(client, scope, identity, patch)`     | `PATCH /store/customers/me`                 | resolve-or-provision, then names, phone and consent; an empty string clears a column                 |
| `listCustomerAddresses(client, scope, identity)`     | `GET /store/customers/me/addresses`         | the customer's addresses, default shipping first, then oldest first                                  |
| `addCustomerAddress(client, scope, identity, input)` | `POST /store/customers/me/addresses`        | validates, decides the default flags under a lock on the customer row, inserts (201)                 |
| `findCustomerForSubject(client, storeId, subject)`   | `GET /store/orders/{orderId}`               | read-only `{ id, status }` or null — for routes that must not create a customer                      |
| `customerEmailHash(email)`                           | —                                           | `email_hash` of the events contract (sha256 of the trimmed, lowercased email)                        |

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
| `exportCustomer`        | `store_admin`          | `buildCustomerExport` (`gdpr.ts`)            | `requestCustomerExport` (202, one `customer.export_requested` per request) + `buildCustomerExport` (the bundle); see below                                                                                                                                                |

### Erasure and export (GDPR; manager decisions 2026-10-08)

**Erasure** is synchronous (one transaction) although the contract says "scheduled": the 202 answers both a fresh
erasure and the replay on an already erased customer (no-op: nothing written, no second event). In that transaction:

- `status` → `erased`; `email` → **`erased+<customer_id>@invalid`** (the column is NOT NULL and unique per store;
  `.invalid` is reserved by RFC 2606, so the placeholder can never receive mail); `first_name`, `last_name`,
  `phone`, `keycloak_subject` → null; `consent` and `metadata` → `{}`. The id, store, group and timestamps stay.
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
erased → 404. `exportCustomer` (202) writes one `customer.export_requested` row per request (no dedupe; ids
only) — the hand-over to the delivery job of Integration 2b (storage + email), which calls this function.

## Known gaps

- **Stale email after a change at Keycloak.** The row keeps the email it was created (or adopted) with. Until an
  email-change sync exists (Phase 3, window 13), `GET /store/customers/me` shows the old address, the
  `email_hash` in events is the old one, and `registerCustomer` compares its body against the token's NEW email.
  Order reads are not affected: they match on the token's verified email, never on the row's.
- **No operation changes or deletes an address** (Store API 0.5.1 / 0.4.9): the default moves only when a new
  address is added with a default flag. A `PATCH` / `DELETE …/addresses/{id}` is a new operation, not a status;
  it is not part of #303.
- **A linked cart is readable by anyone holding the cart id** (cart ids are the capability today; Phase 3), and
  older guest orders are not back-filled: the read-time match on a verified token email covers them.

## Events and audit

One transaction per use case; whatever happened to the row yields **one** event and **one** audit row, or none
when nothing changed.

| Event              | When                                                                          | Payload                                                                                        |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `customer.created` | the row was created (names/consent included)                                  | `customer_id`, `identity_id`, `email_hash`, `status`, `customer_group_id`, `marketing_consent` |
| `customer.updated` | adoption; names / phone / consent changed; an address added (`['addresses']`) | the same + `changed_fields` (column names)                                                     |

Audit actions: `customer.create`, `customer.link`, `customer.update`, and `customer_address.create` (entity
`customer_address`, `after` = customer id and the two default flags); actor = the customer (`actor_type`
`customer`, `actor_id` = the customer id). Neither an event nor an audit row carries an email, a name, a line, a
city, a postal code, a phone or the Keycloak subject, and nothing in this module logs (tested).

## Tests

`customers.test.ts` (database, as `platform_app`): provisioning once — also under eight concurrent first
requests —, store isolation, register (create / update / no-op / email mismatch), the collision rule including
two identities racing for one guest row, disabled / erased, `updateCustomer` (clear / no-op / over-long), addresses
(first = default, explicit flags, six concurrent first addresses → one default each, validation, the cap, store
isolation), and the no-PII check over the outbox, the audit log and the console. HTTP behaviour, the verifier seam and the live Keycloak test: `test/customers-api.test.ts`.
