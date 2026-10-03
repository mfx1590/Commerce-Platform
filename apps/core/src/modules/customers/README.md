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
