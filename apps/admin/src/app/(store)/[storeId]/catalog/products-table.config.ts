import type { TableQueryDefaults } from '@/lib/table/query-state';

/**
 * Plain module, not the `'use client'` one — see the note in `stores-table.config.ts`: a constant
 * exported from a client module and imported by a server component becomes a client reference, and
 * an array that is no longer iterable is how that failure actually shows up.
 */

/** `listProducts` in Admin API 0.2.0 sorts by exactly these. */
export const PRODUCTS_SORTABLE_COLUMNS = [
  'title',
  'handle',
  'status',
  'created_at',
  'updated_at',
] as const;

/** The contract's own filter parameters — anything else would be a 400. */
export const PRODUCT_FILTER_KEYS = ['q', 'status', 'category_id'] as const;

export const PRODUCTS_TABLE_DEFAULTS: TableQueryDefaults = { sort: 'updated_at', order: 'desc' };
