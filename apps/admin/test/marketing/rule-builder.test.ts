/**
 * The rule builder emits exactly the `SegmentRules` JSON the contract defines (#149).
 *
 * `toRules` is a plain, pure function, so the acceptance criterion is testable without rendering anything.
 * The *structural* guarantee is the type: `toRules` returns `AdminComponents['SegmentRules']`, generated from
 * `admin-api.yaml`, so a shape the contract does not describe does not compile. These tests pin the
 * behaviour a type cannot: which values become numbers, which become arrays, what happens to an incomplete
 * row, and that the AND/OR nesting is the contract's and not an approximation of it.
 *
 * The end-to-end proof — the Admin API itself accepting the body — is `test-contract/marketing/marketing.test.ts`,
 * which posts this output to Prism and lets the spec validate it.
 */

import { describe, expect, it } from 'vitest';
import {
  SEGMENT_FIELDS,
  predicateFor,
  predicateProblem,
  toDraft,
  toRules,
  type DraftGroup,
} from '@/app/(store)/[storeId]/marketing/segments/_rules';

const group = (...rows: { field: string; op: string; value: string }[]): DraftGroup => ({
  any: rows,
});

describe('toRules', () => {
  it('nests groups as AND and rows as OR, exactly as the contract does', () => {
    const rules = toRules([
      group(
        { field: 'total_spent_minor', op: 'gte', value: '50000' },
        { field: 'orders_count', op: 'gte', value: '3' },
      ),
      group({ field: 'consent', op: 'granted', value: 'email' }),
    ]);

    expect(rules).toEqual({
      v: 1,
      all: [
        {
          any: [
            { field: 'total_spent_minor', op: 'gte', value: 50_000 },
            { field: 'orders_count', op: 'gte', value: 3 },
          ],
        },
        { any: [{ field: 'consent', op: 'granted', value: 'email' }] },
      ],
    });
  });

  it('types each value the way its field requires', () => {
    const rules = toRules([
      group({ field: 'orders_count', op: 'eq', value: '2' }),
      group({ field: 'last_order_at', op: 'after', value: '2026-01-01' }),
      group({ field: 'tags', op: 'includes', value: '  wholesale  ' }),
      group({ field: 'country', op: 'in', value: 'nl, de' }),
      group({
        field: 'customer_group_ids',
        op: 'not_in',
        value: '3f2a6d1e-4b7c-4a9e-8d5f-2c6b1a9e7d40',
      }),
    ]);

    const predicates = rules!.all.map((g) => g.any[0]);
    // A number, not the string the input gave us.
    expect(predicates[0]).toEqual({ field: 'orders_count', op: 'eq', value: 2 });
    // Normalised to ISO-8601 so a saved rule does not depend on the browser's date format.
    expect(predicates[1]).toEqual({
      field: 'last_order_at',
      op: 'after',
      value: new Date('2026-01-01').toISOString(),
    });
    expect(predicates[2]).toEqual({ field: 'tags', op: 'includes', value: 'wholesale' });
    // Comma-separated text becomes an array of upper-case codes, which is what the schema requires.
    expect(predicates[3]).toEqual({ field: 'country', op: 'in', value: ['NL', 'DE'] });
    expect(predicates[4]).toEqual({
      field: 'customer_group_ids',
      op: 'not_in',
      value: ['3f2a6d1e-4b7c-4a9e-8d5f-2c6b1a9e7d40'],
    });
  });

  it('emits every field and operator the closed set allows', () => {
    const sample: Record<string, string> = {
      orders_count: '3',
      total_spent_minor: '1000',
      last_order_at: '2026-01-01',
      tags: 'wholesale',
      consent: 'email',
      country: 'NL',
      customer_group_ids: '3f2a6d1e-4b7c-4a9e-8d5f-2c6b1a9e7d40',
    };
    for (const spec of SEGMENT_FIELDS) {
      for (const { op } of spec.ops) {
        const rules = toRules([group({ field: spec.field, op, value: sample[spec.field]! })]);
        expect(rules, `${spec.field}.${op}`).not.toBeNull();
        expect(rules!.all[0]!.any[0]).toMatchObject({ field: spec.field, op });
      }
    }
  });

  it('is null while any row is incomplete, so half a rule is never sent', () => {
    expect(toRules([group({ field: 'orders_count', op: 'gte', value: '' })])).toBeNull();
    expect(toRules([group({ field: 'orders_count', op: 'gte', value: 'three' })])).toBeNull();
    expect(toRules([group({ field: 'country', op: 'in', value: 'nl' })])).not.toBeNull();
    expect(toRules([group({ field: 'country', op: 'in', value: 'netherlands' })])).toBeNull();
    expect(toRules([group({ field: 'consent', op: 'granted', value: '' })])).toBeNull();
  });

  it('treats no groups as every customer, not as nobody', () => {
    // `all: []` is the contract's "no constraints"; an empty group would match nobody, so it is dropped
    // rather than sent — the schema requires `any` to have at least one predicate.
    expect(toRules([])).toEqual({ v: 1, all: [] });
    expect(toRules([{ any: [] }])).toEqual({ v: 1, all: [] });
  });

  it('never emits an operator the field does not allow', () => {
    // `gte` is not one of the `tags` operators, so the row is incomplete rather than quietly sent.
    expect(toRules([group({ field: 'tags', op: 'gte', value: 'wholesale' })])).toBeNull();
    expect(predicateProblem({ field: 'tags', op: 'gte', value: 'x' })).toMatch(/comparison/);
  });
});

describe('predicateFor', () => {
  it('switches the operator with the field, so no row is left in an impossible state', () => {
    for (const spec of SEGMENT_FIELDS) {
      const row = predicateFor(spec.field);
      expect(row.field).toBe(spec.field);
      expect(spec.ops.some((o) => o.op === row.op)).toBe(true);
    }
  });
});

describe('toDraft', () => {
  it('round-trips saved rules back into editable rows', () => {
    const rules = toRules([
      group(
        { field: 'total_spent_minor', op: 'gte', value: '50000' },
        { field: 'country', op: 'in', value: 'NL, DE' },
      ),
    ]);
    const draft = toDraft(rules);

    expect(draft).toEqual([
      {
        any: [
          { field: 'total_spent_minor', op: 'gte', value: '50000' },
          { field: 'country', op: 'in', value: 'NL, DE' },
        ],
      },
    ]);
    // And back again unchanged, which is what makes editing a saved segment safe.
    expect(toRules(draft)).toEqual(rules);
  });

  it('yields an empty draft for anything it does not recognise instead of throwing', () => {
    for (const bad of [null, undefined, 42, 'rules', {}, { all: 'nope' }, { v: 1 }]) {
      expect(toDraft(bad)).toEqual([]);
    }
  });
});
