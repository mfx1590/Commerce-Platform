/**
 * The rule-builder's model of the frozen segment grammar (#149).
 *
 * **Plain module, no React, no `'use client'`** — the builder is a client component, the pages that render it
 * are server components, and a constant exported from a client module becomes a client reference when a server
 * component imports it (Memory-main global gotchas).
 *
 * The grammar itself is the contract's: `#/components/schemas/SegmentRules` and `SegmentPredicate` in
 * `admin-api.yaml` since contracts-v0.4.4. This file is the *editing* model — a flat list of rows the UI can
 * render — plus the two pure functions that convert between it and the contract shape. `toRules` is what the
 * acceptance criterion tests: the builder must emit exactly the JSON the contract defines. The type is the
 * structural half of that guarantee (a shape the contract does not describe does not compile) and
 * `test-contract/marketing` is the other half — it posts this output to Prism and lets the spec validate it,
 * so no copy of the grammar lives in this app.
 */

import type { AdminComponents } from '@/lib/api/admin-client';

export type SegmentRules = AdminComponents['SegmentRules'];
export type SegmentPredicate = SegmentRules['all'][number]['any'][number];

export type ValueKind =
  'integer' | 'money' | 'timestamp' | 'text' | 'consent' | 'countries' | 'uuids';

export interface FieldSpec {
  readonly field: SegmentPredicate['field'];
  readonly label: string;
  readonly ops: readonly { readonly op: string; readonly label: string }[];
  readonly value: ValueKind;
  readonly hint: string;
}

/**
 * Exactly the seven fields of `SegmentPredicate`, with the operators each one allows. Adding a row here
 * without adding it to the contract would produce a 400 at save time, which is the point of the closed set.
 */
export const SEGMENT_FIELDS: readonly FieldSpec[] = [
  {
    field: 'orders_count',
    label: 'Orders placed',
    ops: [
      { op: 'gte', label: 'at least' },
      { op: 'lte', label: 'at most' },
      { op: 'eq', label: 'exactly' },
    ],
    value: 'integer',
    hint: 'Cancelled orders are not counted.',
  },
  {
    field: 'total_spent_minor',
    label: 'Total spent',
    ops: [
      { op: 'gte', label: 'at least' },
      { op: 'lte', label: 'at most' },
      { op: 'eq', label: 'exactly' },
    ],
    value: 'money',
    hint: 'In the store currency. Cancelled orders are not counted.',
  },
  {
    field: 'last_order_at',
    label: 'Last order',
    ops: [
      { op: 'after', label: 'after' },
      { op: 'before', label: 'before' },
    ],
    value: 'timestamp',
    hint: 'A customer who never ordered matches neither direction.',
  },
  {
    field: 'tags',
    label: 'Tag',
    ops: [
      { op: 'includes', label: 'includes' },
      { op: 'excludes', label: 'excludes' },
    ],
    value: 'text',
    hint: 'Read from customer.metadata.tags; no tags means the tag is simply absent.',
  },
  {
    field: 'consent',
    label: 'Marketing consent',
    ops: [
      { op: 'granted', label: 'granted for' },
      { op: 'not_granted', label: 'not granted for' },
    ],
    value: 'consent',
    hint: 'Someone who was never asked counts as not granted.',
  },
  {
    field: 'country',
    label: 'Country',
    ops: [
      { op: 'in', label: 'is one of' },
      { op: 'not_in', label: 'is not one of' },
    ],
    value: 'countries',
    hint: 'The default shipping address only — a stale second address never pulls someone in.',
  },
  {
    field: 'customer_group_ids',
    label: 'Customer group',
    ops: [
      { op: 'in', label: 'is one of' },
      { op: 'not_in', label: 'is not one of' },
    ],
    value: 'uuids',
    hint: 'Matched against the customer group on the customer.',
  },
] as const;

export const CONSENT_CHANNELS = ['email', 'sms'] as const;

export function specFor(field: string): FieldSpec | undefined {
  return SEGMENT_FIELDS.find((f) => f.field === field);
}

/** One editable row. `value` is always a string in the UI; `toRules` is what types it. */
export interface DraftPredicate {
  field: string;
  op: string;
  value: string;
}

/** A group of rows combined with OR. Groups are combined with AND. */
export interface DraftGroup {
  any: DraftPredicate[];
}

export const EMPTY_PREDICATE: DraftPredicate = { field: 'orders_count', op: 'gte', value: '1' };

export function emptyDraft(): DraftGroup[] {
  return [];
}

/** The default row for a field, so switching field never leaves an operator the field does not allow. */
export function predicateFor(field: string): DraftPredicate {
  const spec = specFor(field);
  if (spec === undefined) return { ...EMPTY_PREDICATE };
  return { field, op: spec.ops[0]!.op, value: '' };
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Why a row cannot be converted, for the inline message. `null` means it is fine. */
export function predicateProblem(row: DraftPredicate): string | null {
  const spec = specFor(row.field);
  if (spec === undefined) return 'Unknown field.';
  if (!spec.ops.some((o) => o.op === row.op))
    return `${spec.label} does not support that comparison.`;

  switch (spec.value) {
    case 'integer':
    case 'money': {
      const n = Number(row.value);
      if (row.value.trim() === '' || !Number.isInteger(n)) return 'A whole number is needed.';
      if (n < 0) return 'Must not be negative.';
      return null;
    }
    case 'timestamp':
      return row.value.trim() === '' || Number.isNaN(Date.parse(row.value))
        ? 'A date is needed.'
        : null;
    case 'text':
      return row.value.trim() === '' ? 'A value is needed.' : null;
    case 'consent':
      return (CONSENT_CHANNELS as readonly string[]).includes(row.value) ? null : 'Pick a channel.';
    case 'countries': {
      const list = parseList(row.value);
      if (list.length === 0) return 'At least one country code.';
      // Case-insensitive on the way in — `toPredicate` upper-cases for the contract. Refusing `nl` when we
      // are about to write `NL` anyway is a validation message nobody learns anything from.
      return list.every((c) => /^[A-Za-z]{2}$/.test(c))
        ? null
        : 'Two-letter country codes, comma separated (NL, DE).';
    }
    case 'uuids': {
      const list = parseList(row.value);
      if (list.length === 0) return 'At least one group id.';
      return list.every((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      )
        ? null
        : 'Comma-separated ids.';
    }
  }
}

function toPredicate(row: DraftPredicate): SegmentPredicate {
  const spec = specFor(row.field)!;
  switch (spec.value) {
    case 'integer':
    case 'money':
      return { field: row.field, op: row.op, value: Number(row.value) } as SegmentPredicate;
    case 'timestamp':
      return {
        field: row.field,
        op: row.op,
        value: new Date(Date.parse(row.value)).toISOString(),
      } as SegmentPredicate;
    case 'countries':
      return {
        field: row.field,
        op: row.op,
        value: parseList(row.value).map((c) => c.toUpperCase()),
      } as SegmentPredicate;
    case 'uuids':
      return { field: row.field, op: row.op, value: parseList(row.value) } as SegmentPredicate;
    default:
      return { field: row.field, op: row.op, value: row.value.trim() } as SegmentPredicate;
  }
}

/**
 * The draft as the contract's `SegmentRules`. Returns `null` when any row is incomplete, so the builder never
 * sends half a rule and gets a 400 it could have prevented — the server still decides, this just stops the
 * obviously-wrong request.
 *
 * Empty groups are dropped rather than sent: the contract requires `any` to have at least one predicate, and
 * an empty group would match nobody, which is never what someone meant to save. `all: []` (no groups at all)
 * is legal and means every customer of the store.
 */
export function toRules(groups: readonly DraftGroup[]): SegmentRules | null {
  const all: SegmentRules['all'] = [];
  for (const group of groups) {
    const rows = group.any.filter((row) => row.field !== '' || row.value !== '');
    if (rows.length === 0) continue;
    if (rows.some((row) => predicateProblem(row) !== null)) return null;
    all.push({ any: rows.map(toPredicate) });
  }
  return { v: 1, all };
}

/** The saved rules as editable rows. Unknown shapes yield an empty draft rather than throwing. */
export function toDraft(rules: unknown): DraftGroup[] {
  if (rules === null || typeof rules !== 'object') return [];
  const all = (rules as { all?: unknown }).all;
  if (!Array.isArray(all)) return [];
  return all.flatMap((group): DraftGroup[] => {
    const any = (group as { any?: unknown }).any;
    if (!Array.isArray(any)) return [];
    return [
      {
        any: any.map((p): DraftPredicate => {
          const row = p as { field?: unknown; op?: unknown; value?: unknown };
          const value = Array.isArray(row.value) ? row.value.join(', ') : String(row.value ?? '');
          return { field: String(row.field ?? ''), op: String(row.op ?? ''), value };
        }),
      },
    ];
  });
}
