# registry — store & channel registry

Owner: window 1 (core). Schema: `packages/db/migrations/0003_store_registry.sql` (frozen with contracts-v0.1):
`store`, `store_domain`, `store_locale`, `store_currency`, `sales_channel`, `store_api_key`. No migrations of its
own.

## Purpose

The tenant directory. A store is a brand; everything store-scoped in the platform hangs off `store.id`. This module
creates and updates stores, their hostnames, locales, currencies, sales channels and API keys, and is what the
Admin API `registry` routes (`/admin/stores…`, task 1.7) and the tenant middleware (`X-Publishable-Key` lookup, task
1.3) call.

## Public API (`src/modules/registry/index.ts`)

Every function takes a `ScopedClient` from `@platform/db` (see apps/core README "How a module gets a tenant client")
and an optional `Actor` (`{ id, type, requestId }`, default `system`), and runs **one transaction**: the row change,
the `audit_log` row and the outbox rows commit or roll back together.

| Function                                                                                 | Scope        | Audit action                                          | Event                                                                     |
| ---------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `listStores(client, { page, limit, sort, order })` → `Page<Store>` (sort `code           | name         | status                                                | created_at`, default `created_at desc`; `order`only with`sort`)           | any | —   | —   |
| `getStore(client, id)` → `Store`                                                         | any          | —                                                     | —                                                                         |
| `createStore(client, StoreInput, actor)` → `Store`                                       | organization | `store.create`                                        | `store.created`                                                           |
| `updateStore(client, id, StoreInput, actor)` → `Store`                                   | any visible  | `store.update`                                        | `store.updated` (`changed_fields`, sorted; no event when nothing changed) |
| `listDomains(client, storeId)` → `Domain[]`                                              | any visible  | —                                                     | —                                                                         |
| `addDomain(client, storeId, { hostname, is_primary })`                                   | any visible  | `store_domain.create`                                 | —                                                                         |
| `updateDomain(client, storeId, domainId, { is_primary })` → `Domain` (moves the primary) | any visible  | `store_domain.update`                                 | `store.updated` (`changed_fields: ['domains']`)                           |
| `listLocales` / `addLocale(client, storeId, locale, { isDefault })`                      | any visible  | `store_locale.create` (`store.update` when default)   | `store.updated` when default                                              |
| `listCurrencies` / `addCurrency(client, storeId, ccy, { isDefault })`                    | any visible  | `store_currency.create` (`store.update` when default) | `store.updated` when default                                              |
| `listSalesChannels` / `createSalesChannel(client, storeId, { code, name, type })`        | any visible  | `sales_channel.create`                                | —                                                                         |
| `listApiKeys(client, storeId)` → `ApiKey[]` (never the key)                              | any visible  | —                                                     | —                                                                         |
| `createApiKey(client, storeId, { name, type, sales_channel_id })` → `ApiKey & { key }`   | any visible  | `store_api_key.create`                                | —                                                                         |
| `revokeApiKey(client, storeId, keyId)` → `ApiKey` (idempotent; 409 `last_live_key`)      | any visible  | `store_api_key.revoke`                                | `store.updated` (`changed_fields: ['api_keys']`)                          |

Return types are the contract schemas (`AdminComponents['schemas']['Store' | 'Domain' | 'SalesChannel' | 'ApiKey']`).

Rules the module enforces:

- `createStore` needs organization scope (the Admin API maps `x-permission: owner organization:hq` to it);
  a store-scoped client gets `forbidden`. Default locale/currency rows are created with the store.
  `locales[]` / `currencies[]` are **sets** (Admin API 0.4.7, #279): a list given on create or update REPLACES
  the enabled set — rows outside it are deleted, missing ones inserted, and the default (given in the same
  request, or the current one) is always kept; `[]` leaves the default alone; an omitted field leaves the set
  unchanged. "Current" means current when the write happens: `updateStore`, `addLocale` and `addCurrency` lock
  the store row first (`lockStore`, `FOR NO KEY UPDATE` — inserts that reference the store are not held up) and
  only then read the default and the sets, so overlapping updates run one after the other; a replacement can
  no longer delete a default row a concurrent request just made, nor can two replacements leave the union
  (#308 review; concurrency tests in `registry.test.ts`). Removing a currency or locale that is still in use is not blocked: no foreign key references
  the two tables (a test pins that; if one ever refuses the delete the answer is 409 naming the constraint),
  existing carts keep reading in their currency, new carts and product reads refuse it. Every store read
  returns `currencies` / `locales`, default first. Codes are lowercase kebab-case, currencies ISO-4217, countries ISO-3166-1 alpha-2.
- Exactly one primary domain per store (`store_domain_one_primary` index; the module demotes the previous one; the
  first domain is primary by default). `updateDomain` moves the flag to an existing domain in one transaction
  (rows locked, clear then set); `is_primary: false` on the current primary is a 409 — a store always has
  one; a request that changes nothing answers the row and writes nothing. Exactly one default locale and currency (mirrors `store.default_*`).
- API keys: plain key `pk_<code>_<40 hex>` / `sk_…`, returned once; stored `key_hash = sha256(plain)`,
  `key_prefix = first 8 chars`. `revoked_at` set → the tenant middleware answers 401.
  `revokeApiKey` is idempotent (an already revoked key answers its row with the same `revoked_at`; nothing
  written) and refuses the store's last publishable key with `revoked_at IS NULL` with 409 `last_live_key`
  (`details.key_id`). The store's key rows are locked for the decision, so two concurrent revokes of the
  last two live keys cannot both pass. Secret keys are neither counted nor refused.
- Errors are `AppError` (`src/lib/errors.ts`) with the contract codes: `validation_error`, `forbidden`, `not_found`,
  `conflict` (unique violations are mapped).

## Store onboarding (#413, Admin API 0.4.11 / CONTRACT CHANGE #417)

`onboardStore(client, input, registrar, actor)` creates a brand in ONE transaction, then registers it in OpenFGA:

1. the legal entity — inline (`legal_entity`, created here; code unique per organization) or an existing one
   (`legal_entity_id`; unknown → 400). Exactly one of the two, else 400;
2. the store in `draft`, with the server-owned conventions `content_space_id = <code>`,
   `search_index = <code>_products`, `timezone` default `UTC`;
3. the enabled locales and currencies (the defaults first, through the same set sync as `updateStore`);
4. the primary domain (`domain.hostname`, lowercased; a hostname another store has → 409);
5. one `web` sales channel named like the store;
6. one `publishable` key named `storefront`, bound to that channel — the plain key is in the response ONCE
   (`publishable_key.key`), the row holds the sha256 and the 8-character prefix;
7. one `audit_log` row (`store.onboard`, no key material) and the `store.created` outbox row — same transaction;
8. **after the commit**, `registrar.ensureStoreObject(storeId)`: the `store:<id>#organization@organization:hq`
   tuple without which no scope resolution ever shows the store (`StoreRegistrar`, see below).

Idempotent by `code`: the same input again answers the same store with `publishable_key: null` and writes nothing
(the route answers 200 instead of 201) — and runs step 8 again, which is how a registration that failed after the
commit is repaired by simply calling again. The same code with a different definition is a 409 naming the fields
that differ (`details.differs`). A failure anywhere inside the transaction leaves no row of any kind
(onboarding.test.ts forces one after the key insert with a trigger).

`activateStore(client, storeId, registrar, actor)` moves `draft` / `paused` → `active` when every prerequisite
is present, with an audit row (`store.activate`) and `store.updated` (`changed_fields: ['status']`); an active
store is a no-op 200; `archived` is a 409 with `details.status`. The prerequisites, reported in this order in
`details.missing` (409 `conflict`): `legal_entity`, `locale`, `currency`, `primary_domain`, `publishable_key`
(a live one), `fga_object`. `updateStore` with `status: 'active'` runs the SAME gate (`refuseUnlessReady`) —
pass `{ registrar }` to it; without one the OpenFGA object counts as missing, never as present.

**`StoreRegistrar`** (`{ ensureStoreObject(storeId), hasStoreObject(storeId) }`): the registry never talks to
OpenFGA itself. The HTTP layer hands in `src/http/store-registrar.ts`, which writes through window 2's
`ensureStoreObject` of `@platform/auth-sdk` (#415 / #421: read first, write only when missing, a concurrent
duplicate tolerated, OpenFGA unreachable = 503 fail closed) and checks by reading the same tuple
(`storeObjectTuple`); tests use `inMemoryStoreRegistrar()` from this module. The live assertion — the seeded
owner sees an onboarded store through OpenFGA scope resolution, a store admin of other brands gets 403, and
activation reads the real tuple — is `test/auth-live.test.ts` "#413 onboarding (live)". A store created before
this task (through `createStore`) is repaired by `pnpm --filter @platform/auth-sdk fga:reconcile --fix`.

Routes (`src/http/admin-routes.ts`): `POST /admin/onboarding/stores` (`onboardStore`, 201 / 200 / 400 / 409 / 422) and `POST /admin/stores/{storeId}/activate` (`activateStore`, 200 / 404 / 409), both `owner` on
`organization:hq`; `updateStore` gains 404 / 409 / 422 (Admin API 0.4.11, contracts-v0.4.13).

### Store settings the core reads (`settings-schema.ts`)

`store.settings` stays free-form by contract, but every key the core reads is checked by SHAPE on `createStore`,
`updateStore` and `onboardStore`: a wrong type is the contract's 422 `validation_error` with `details.settings`
mapping each offending path to what was expected; unknown keys are preserved untouched (other modules add their
own without a registry change). The readers keep their forgiving fallbacks — this is the write-side gate.

| Path                                                              | Shape                           | Read by                                   |
| ----------------------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| `payment.invoice_allowed`                                         | boolean                         | Store API `payment.methods` (#350 / #358) |
| `payment.methods`                                                 | DERIVED — refused when written  | computed by `GET /store`, never stored    |
| `support_refund_limit_minor`                                      | integer ≥ 0 (absent = no limit) | payments refund router (window 7)         |
| `fulfillment.provider`                                            | non-empty string                | fulfillment registry (window 8)           |
| `fulfillment.routing.default`                                     | string or null (warehouse code) | fulfillment routing (window 8)            |
| `fulfillment.routing.countries`                                   | `{ CC: warehouse code }`        | fulfillment routing (window 8)            |
| `tax.provider`                                                    | `table` \| `stripe`             | tax module (window 7)                     |
| `tax.prices_include_tax`                                          | boolean                         | tax + cart pricing (#221)                 |
| `tax.shipping_taxable`                                            | boolean                         | tax module (#352)                         |
| `shipping.provider`                                               | non-empty string                | shipping `carrierConfigFor` (window 8)    |
| `shipping.carrier_account_ids`                                    | string[]                        | shipping (window 8)                       |
| `shipping.services`                                               | string[]                        | shipping (window 8)                       |
| `shipping.default_parcel.{length_cm,width_cm,height_cm,weight_g}` | integer ≥ 1                     | shipping (window 8)                       |
| `shipping.label_format`                                           | non-empty string                | shipping (window 8)                       |
| `fraud.providers`                                                 | array of `rules` \| `radar`     | fraud `fraudSettingsFrom` (window 7)      |
| `fraud.velocity.{max_orders,window_minutes}`                      | integer ≥ 1                     | fraud (window 7)                          |
| `fraud.country_mismatch`                                          | `review` \| `allow`             | fraud (window 7)                          |
| `fraud.radar_highest`                                             | `block` \| `review`             | fraud (window 7)                          |

A module that starts reading a new key adds its row here and its line in `STORE_SETTINGS_SHAPES` (the test pins
that every group has its leaves listed).

## Events

- `store.created` v1 — on `createStore`.
- `store.updated` v1 — on `updateStore` and on default locale/currency changes; `changed_fields` lists the `Store`
  fields that differ, `currencies` / `locales` included when the enabled set really changed (compared as sets,
  so a repeat of the same set emits nothing). Also on every other registry mutation — audit alone is not enough: `addDomain` (`['domains']`), `addLocale` /
  `addCurrency` without a new default (`['locales']` / `['currencies']`; nothing when it was already enabled),
  `createSalesChannel` (`['sales_channels']`), `createApiKey` (`['api_keys']`), `revokeApiKey` (`['api_keys']`) and on a primary move
  by `updateDomain` (`['domains']`): the payload names the area only — never key material, never a hostname —
  and an idempotent repeat emits nothing.

Both go through `src/outbox/withEvents` (validated against `@platform/events` schemas, same transaction).

## Permissions (Admin API, task 1.7)

`listStores` viewer `store:*` · `createStore` owner `organization:hq` · `getStore`/`listDomains`/`listSalesChannels`
viewer `store:{id}` · `updateStore`/`createSalesChannel`/`listApiKeys`/`createApiKey` store_admin `store:{id}` ·
`addDomain` / `updateDomain` owner `organization:hq` · `revokeApiKey` store_admin `store:{id}`.

## How to test

`pnpm --filter @platform/core test` — `registry.test.ts` creates a throwaway database with `createTestDatabase()`
(`@platform/db/testing`), seeds an organization and legal entity as the owner, then exercises every function as
`platform_app` (RLS enforced): scope rules, one-primary/one-default invariants, key hashing, audit + outbox rows
in the same transaction, and rollback when an event fails validation.
