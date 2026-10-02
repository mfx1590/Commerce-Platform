# customers

Customer self-service on the Store API (#303): the store-level `customer` row of a signed-in shopper
(`packages/db` migration 0005). Owner: window 1 (ruling 2026-10-02). The Admin API customer routes are not here.

There is **no "register first" step**. Every `/store/customers*` route resolves the customer from the verified
customers-realm token, and creates the row when it does not exist yet. The store comes from the publishable key;
the subject and the email come from the **token only** — never from a request body.

## Public API (`index.ts`)

| Function                                           | Route                                       | What it does                                                                                         |
| -------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `resolveCustomer(client, scope, identity)`         | `GET /store/customers/me` (and every `/me`) | the customer of the token in this store, created on first use (`marketing_consent` false)            |
| `registerCustomer(client, scope, identity, input)` | `POST /store/customers`                     | resolve-or-provision, then names and consent; `{ customer, created }` — the route answers 201 or 200 |
| `findCustomerForSubject(client, storeId, subject)` | `GET /store/orders/{orderId}`               | read-only `{ id, status }` or null — for routes that must not create a customer                      |
| `customerEmailHash(email)`                         | —                                           | `email_hash` of the events contract (sha256 of the trimmed, lowercased email)                        |

`identity` is `{ subject, email?, emailVerified }` from a verified token (`src/http/customer-routes.ts` builds it;
`emailVerified` is true only for an explicit `email_verified: true` claim, absent = false). `scope` is
`{ organizationId, storeId, requestId }` from the tenant context. `client` is the store-scoped client: RLS keeps
every read and write inside the store of the key.

`GET /store/customers/me/orders` is the orders module's `listStoreOrders` (the route calls it with the resolved
customer id). `updateMe` and the address operations follow in the next PR.

## Rules

- **Provisioned once.** `INSERT … ON CONFLICT DO NOTHING`, then select: of several first requests of one subject
  exactly one creates the row and writes `customer.created` and the audit row; the others find it.
- **Email collision** — the token's email is already on a row of this store (a guest row, or another identity's):
  - the token's email is **verified** and the row has **no subject** → the row is adopted: it gets the subject,
    becomes `registered`, one `customer.updated` (`['keycloak_subject', 'status']`) and one audit row
    (`customer.link`);
  - anything else → 409 `conflict`, nothing written. An unverified email never adopts: the customers realm has
    open registration, so anyone can hold a token with any unverified address.
- **Disabled and erased** customers are a 401 on every route and are never provisioned again — also when the
  row has no subject yet and a verified token arrives for its email.
- **A token without an email** reads an existing customer; it cannot create one (401, `reason: no_email`).
- **`registerCustomer`'s body `email`** is a confirmation, not an input: it must equal the token's email
  (trimmed, case-insensitive), otherwise 400 `validation_error` and nothing is written.
- **Consent** is recorded only when the answer changes (`consent.marketing_email = { granted, at, source:
'storefront' }`). A `false` on a customer who was never asked records nothing, so "never asked" stays different
  from "opted out" — the marketing module's re-consent segments depend on that difference.
- The email is stored trimmed and lowercased. A later change of the email at Keycloak does not rewrite the row.

## Events and audit

One transaction per use case; whatever happened to the row yields **one** event and **one** audit row, or none
when nothing changed.

| Event              | When                                         | Payload                                                                                        |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `customer.created` | the row was created (names/consent included) | `customer_id`, `identity_id`, `email_hash`, `status`, `customer_group_id`, `marketing_consent` |
| `customer.updated` | adoption, or names / consent changed         | the same + `changed_fields` (column names)                                                     |

Audit actions: `customer.create`, `customer.link`, `customer.update`; actor = the customer (`actor_type`
`customer`, `actor_id` = the customer id). Neither the event nor the audit row carries an email, a name or the
Keycloak subject, and nothing in this module logs (tested).

## Tests

`customers.test.ts` (database, as `platform_app`): provisioning once — also under eight concurrent first
requests —, store isolation, register (create / update / no-op / email mismatch), the collision rule including
two identities racing for one guest row, disabled / erased, and the no-PII check over the outbox, the audit log
and the console. HTTP behaviour, the verifier seam and the live Keycloak test: `test/customers-api.test.ts`.
