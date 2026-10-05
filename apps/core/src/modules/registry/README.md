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
