import type { TableQueryDefaults } from '@/lib/table/query-state';

/** Plain module (not `'use client'`) — see the note in `campaigns-table.config.ts`. */

/** `listSegments` in Admin API 0.3.0 sorts by exactly these. */
export const SEGMENTS_SORTABLE_COLUMNS = [
  'name',
  'materialised_count',
  'last_materialised_at',
  'created_at',
] as const;

/** `listSegments` takes no filters beyond paging and sort. */
export const SEGMENT_FILTER_KEYS = [] as const;

export const SEGMENTS_TABLE_DEFAULTS: TableQueryDefaults = { sort: 'created_at', order: 'desc' };
