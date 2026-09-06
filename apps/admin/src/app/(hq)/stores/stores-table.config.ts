import type { TableQueryDefaults } from '@/lib/table/query-state';

/**
 * Deliberately *not* in `stores-table.tsx`.
 *
 * Anything exported from a `'use client'` module and imported by a server component arrives as a
 * client reference, not the value: an array is no longer iterable and an object's properties read
 * as undefined — silently, in the object case. Table configuration is read on both sides, so it
 * lives in a plain module that both can import.
 */

/** `listStores` in Admin API 0.2.0 sorts by exactly these — anything else is a 400. */
export const STORES_SORTABLE_COLUMNS = ['code', 'name', 'status', 'created_at'] as const;

/** Matching the contract's own default keeps it out of the URL. */
export const STORES_TABLE_DEFAULTS: TableQueryDefaults = { sort: 'created_at', order: 'desc' };
