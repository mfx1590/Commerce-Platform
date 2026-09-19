// Segment types (#147): the contract shapes, the table row, and the one place they differ.
import type { AdminComponents } from '@platform/contracts';
import type { SegmentRules } from './segment-rules';

type ContractSegment = AdminComponents['schemas']['Segment'];
type ContractSegmentInput = AdminComponents['schemas']['SegmentInput'];

/**
 * `rules` is typed as the frozen grammar here, not as the contract's loose `SegmentRules`.
 *
 * Admin API 0.4.3 still describes rules as the flat `{ orders_count, tags, consent, … }` bag with
 * `additionalProperties: true` and "Unknown keys are kept, not rejected", while its own description says the
 * grammar is frozen by this window in Phase 2.3 — which is what the CONTRACT CHANGE filed with this task does.
 * Responses still validate against the frozen document today precisely because it accepts additional properties,
 * so nothing is blocked while the spec catches up.
 */
export interface Segment extends Omit<ContractSegment, 'rules'> {
  rules: SegmentRules;
}

export interface SegmentInput extends Omit<ContractSegmentInput, 'rules'> {
  /** Unvalidated on the way in — `parseSegmentRules` is what turns this into a `SegmentRules`. */
  rules?: unknown;
}

export type SegmentSortField =
  'name' | 'materialised_count' | 'last_materialised_at' | 'created_at';

/** The `sort` enum of `listSegments` in admin-api.yaml. */
export const SEGMENT_SORT_FIELDS: readonly SegmentSortField[] = [
  'name',
  'materialised_count',
  'last_materialised_at',
  'created_at',
];

export interface SegmentListQuery {
  sort?: SegmentSortField;
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/** A row of the `segment` table (migration 0120). `store_id IS NULL` = organization template. */
export interface SegmentRow {
  id: string;
  organization_id: string;
  store_id: string | null;
  template_id: string | null;
  name: string;
  description: string | null;
  rules: unknown;
  materialised_count: number;
  last_materialised_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
