# catalog — categories, products, options, variants, media

Owner: window 1 (core). Schema: `packages/db/migrations/0004_catalog_pricing.sql` (`product_category`, `product`,
`product_option`, `product_variant`, `product_media`; read access to `price` / `price_list`) and
`0007_inventory.sql` (`inventory_level`, read). No migrations of its own. Pricing mutations beyond the
"default list per currency" convenience belong to the pricing module; inventory mutations to window 11.

## Purpose

Per-store catalog: the admin side (`service.ts`) creates, updates, publishes and archives products with their
options, variants, media and default-list prices; the store side (`read-model.ts`) serves the Store API `Product`
shapes for one store in one currency with price and availability. Everything runs through a `ScopedClient` from
`@platform/db`; the caller's RLS scope decides which store's rows exist at all, and every query also filters by the
explicit `storeId`.

## Public API (`src/modules/catalog/index.ts`)

Admin (return the Admin API schemas; one transaction each; `Actor` optional, default `system`):

| Function                                                                                                                  | Audit action              | Event                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `listCategories(client, storeId)` → `AdminCategory[]`                                                                     | —                         | —                                                       |
| `createCategory(client, storeId, CategoryInput)`                                                                          | `product_category.create` | —                                                       |
| `listProducts(client, storeId, { q, status, category_id, sort, order, page, limit })` → `Page<AdminProduct>` (sort `title | handle                    | status                                                  | created_at | updated_at`, default `updated_at desc`; `order`only with`sort`) | —   | —   |
| `getProduct(client, storeId, productId)` → `AdminProduct`                                                                 | —                         | —                                                       |
| `createProduct(client, storeId, ProductInput)` (draft)                                                                    | `product.create`          | `product.updated` (`changed_fields` = the fields given) |
| `updateProduct(client, storeId, productId, ProductInput)`                                                                 | `product.update`          | `product.updated` (changed fields; none → no event)     |
| `publishProduct(client, storeId, productId)`                                                                              | `product.publish`         | `product.published`                                     |
| `archiveProduct(client, storeId, productId)`                                                                              | `product.archive`         | `product.archived`                                      |
| `createVariant(client, storeId, productId, VariantInput)`                                                                 | `product_variant.create`  | `product.updated` (`["variants"]`)                      |
| `updateVariant(client, storeId, variantId, VariantInput)`                                                                 | `product_variant.update`  | `product.updated` (`["variants"]`)                      |

Store read model (Store API schemas, published products only, prices from the store's **active default price list
of the requested currency**, `min_quantity = 1`):

| Function                                                                                | Returns                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `listStoreCategories(client, storeId)`                                                  | `Category[]` (active, flat)                                                                                                                                                    |
| `listStoreProducts(client, storeId, currency, { q, category, tag, sort, page, limit })` | `Page<ProductSummary>` — lowest variant price; `category` includes descendants; `q` = ILIKE stub; `sort` relevance (= newest until window 9) / newest / price_asc / price_desc |
| `getStoreProduct(client, storeId, currency, handle)`                                    | `Product` — options, variants with `price`, `compare_at_price`, `in_stock`, `available_quantity`, media; 404 if not published                                                  |

Rules the module enforces:

- `handle` (product, category) and `sku` are lowercase-kebab / unique per store; unique violations → `409 conflict`.
- `ProductInput.options` / `media` replace the whole set when provided; the first media url becomes `thumbnail_url`.
- Variant `options` must use the product's option names and one of their values (`400 validation_error`).
- `VariantInput.prices` are written to the store's default price list per currency (`400` if the store has no
  default list for that currency).
- Publishing an archived product is refused; publishing twice / archiving twice is idempotent (no second event).
- Availability: `manage_inventory = false` → `in_stock: true`, `available_quantity: null`; otherwise
  `available_quantity = Σ inventory_level.available` over **active** warehouses and `in_stock = available > 0 || allow_backorder`.
- Variants without a price in the requested currency are omitted from the store shapes; products with no priced
  variant are not listed.

## Events

`product.updated` v1 (create, update, variant create/update — `changed_fields`, `variants[]`), `product.published`
v1 (`variants[]`, `published_at`), `product.archived` v1 (`archived_at`). All through `src/outbox/withEvents`,
same transaction as the row change and the `audit_log` row.

## Permissions (Admin API, task 1.7)

`listCategories` / `listProducts` / `getProduct` viewer `store:{id}` · `createCategory` / `createProduct` /
`updateProduct` / `publishProduct` / `createVariant` / `updateVariant` store_staff `store:{id}` · `archiveProduct`
store_admin `store:{id}`.

## How to test

`pnpm --filter @platform/core test` — `catalog.test.ts` seeds a throwaway database with `seed()` from `@platform/db`
(3 stores × 200 products) and runs as `platform_app`: brand-a lists 200 published products (`total = 200`), a
variant with 0 available reports `in_stock: false`, create → publish yields exactly `product.updated` then
`product.published` (`store_id` set, `version = 1`, `published_at IS NULL`), archive emits `product.archived`,
category filter includes children, duplicate handle/sku → 409, brand-b cannot read brand-a.
