/**
 * @platform/cms — public API.
 *
 * - schemas (`schemaTypes`, one export per type) for the Studio
 * - typed documents (`PageDocument`, …) and `documentId` for the storefront fetch layer
 * - `BRAND_DATASETS` / `datasetForStore` — the store code → dataset contract
 * - `validateDocument` — the schemas' own rules, runnable without a Studio
 * - fixtures and the pure seed helpers
 */

export * from './datasets.js';
export * from './fixtures/index.js';
export * from './schema/index.js';
export * from './seed.js';
export * from './types.js';
export * from './validate.js';
