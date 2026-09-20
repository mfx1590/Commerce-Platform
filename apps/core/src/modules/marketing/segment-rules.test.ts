// The frozen rule grammar (#147): what it accepts, what it refuses, and the guarantee that the published JSON
// Schema says the same thing as the parser. No database.
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  compileSegmentRules,
  parseSegmentRules,
  SEGMENT_FIELDS,
  SEGMENT_RULES_SCHEMA,
  segmentQuery,
} from './index';

const rules = (...predicates: unknown[]) => ({
  v: 1,
  all: predicates.map((p) => ({ any: [p] })),
});

const vip = {
  v: 1,
  all: [
    { any: [{ field: 'total_spent_minor', op: 'gte', value: 50_000 }] },
    { any: [{ field: 'consent', op: 'granted', value: 'email' }] },
  ],
};

/** The published schema, compiled the way window 16 would compile it. */
const ajv = (() => {
  const instance = new Ajv2020({ strict: false, allErrors: true });
  const applyFormats = ((addFormats as unknown as { default?: unknown }).default ?? addFormats) as (
    a: Ajv2020,
  ) => void;
  applyFormats(instance);
  return instance.compile(SEGMENT_RULES_SCHEMA);
})();

describe('accepting rules', () => {
  it('parses an AND of ORs and normalises it', () => {
    const parsed = parseSegmentRules(vip);
    expect(parsed.v).toBe(1);
    expect(parsed.all).toHaveLength(2);
    expect(parsed.all[0]!.any[0]).toEqual({
      field: 'total_spent_minor',
      op: 'gte',
      value: 50_000,
    });
  });

  it('treats no rules as every customer of the store, not none', () => {
    for (const empty of [undefined, null, {}, { v: 1, all: [] }]) {
      expect(parseSegmentRules(empty)).toEqual({ v: 1, all: [] });
    }
    expect(compileSegmentRules({ v: 1, all: [] }).where).toBe('TRUE');
  });

  it('accepts every field in the closed set with each of its operators', () => {
    const samples: Record<string, unknown> = {
      orders_count: 3,
      total_spent_minor: 1000,
      last_order_at: '2026-01-01T00:00:00Z',
      tags: 'wholesale',
      consent: 'email',
      country: ['NL', 'DE'],
      customer_group_ids: ['3f2a6d1e-4b7c-4a9e-8d5f-2c6b1a9e7d40'],
    };
    for (const [field, spec] of Object.entries(SEGMENT_FIELDS)) {
      for (const op of spec.ops) {
        const predicate = { field, op, value: samples[field] };
        expect(() => parseSegmentRules(rules(predicate)), `${field}.${op}`).not.toThrow();
      }
    }
  });

  it('normalises a timestamp to ISO-8601 so saved rules do not drift by format', () => {
    const parsed = parseSegmentRules(
      rules({ field: 'last_order_at', op: 'after', value: '2026-01-01T00:00:00+01:00' }),
    );
    expect((parsed.all[0]!.any[0] as { value: string }).value).toBe('2025-12-31T23:00:00.000Z');
  });
});

describe('refusing rules (the closed set)', () => {
  const cases: [string, unknown, string][] = [
    [
      'unknown predicate field',
      rules({ field: 'favourite_colour', op: 'eq', value: 1 }),
      'rules.all[0].any[0].field',
    ],
    [
      'operator not allowed for the field',
      rules({ field: 'tags', op: 'gte', value: 'x' }),
      'rules.all[0].any[0].op',
    ],
    [
      'extra key inside a predicate',
      rules({ field: 'orders_count', op: 'eq', value: 1, weight: 2 }),
      'rules.all[0].any[0].weight',
    ],
    ['extra key at the top level', { v: 1, all: [], mode: 'loose' }, 'rules.mode'],
    ['extra key in a group', { v: 1, all: [{ any: [], not: [] }] }, 'rules.all[0].not'],
    ['wrong version', { v: 2, all: [] }, 'rules.v'],
    ['missing version', { all: [] }, 'rules.v'],
    ['empty any group', { v: 1, all: [{ any: [] }] }, 'rules.all[0].any'],
    [
      'wrong value type',
      rules({ field: 'orders_count', op: 'eq', value: 'three' }),
      'rules.all[0].any[0].value',
    ],
    [
      'non-integer amount',
      rules({ field: 'total_spent_minor', op: 'gte', value: 12.5 }),
      'rules.all[0].any[0].value',
    ],
    [
      'unparseable timestamp',
      rules({ field: 'last_order_at', op: 'after', value: 'yesterday' }),
      'rules.all[0].any[0].value',
    ],
    [
      'unknown consent channel',
      rules({ field: 'consent', op: 'granted', value: 'carrier_pigeon' }),
      'rules.all[0].any[0].value',
    ],
    [
      'lower-case country',
      rules({ field: 'country', op: 'in', value: ['nl'] }),
      'rules.all[0].any[0].value[0]',
    ],
    [
      'empty country list',
      rules({ field: 'country', op: 'in', value: [] }),
      'rules.all[0].any[0].value',
    ],
    [
      'group id that is not a uuid',
      rules({ field: 'customer_group_ids', op: 'in', value: ['everyone'] }),
      'rules.all[0].any[0].value[0]',
    ],
  ];

  it.each(cases)('400s on %s, naming the exact path', (_name, input, path) => {
    try {
      parseSegmentRules(input);
      throw new Error('expected parseSegmentRules to throw');
    } catch (err) {
      const e = err as { code?: string; details?: Record<string, string> };
      expect(e.code).toBe('validation_error');
      expect(Object.keys(e.details ?? {})).toEqual([path]);
    }
  });

  it('refuses the contract old flat shape, which is the whole point of freezing the grammar', () => {
    // Admin API 0.4.3's SegmentRules example — accepted by the document today, refused here on purpose.
    expect(() =>
      parseSegmentRules({
        total_spent_minor: { gte: 50_000 },
        last_order_at: { after: '2025-09-01T00:00:00Z' },
        consent: ['email'],
      }),
    ).toThrow(/invalid segment rules/);
  });
});

describe('the published JSON Schema agrees with the parser', () => {
  // Window 16's worker and the admin rule builder validate against SEGMENT_RULES_SCHEMA rather than calling
  // parseSegmentRules. If the two ever disagree, a rule the admin accepts would 400 at save time — so they are
  // checked against each other here, over the same fixtures.
  const accepted: unknown[] = [
    { v: 1, all: [] },
    vip,
    rules({ field: 'tags', op: 'excludes', value: 'wholesale' }),
    rules({ field: 'country', op: 'not_in', value: ['NL'] }),
    {
      v: 1,
      all: [
        {
          any: [
            { field: 'orders_count', op: 'gte', value: 2 },
            { field: 'total_spent_minor', op: 'gte', value: 10_000 },
          ],
        },
      ],
    },
  ];

  it.each(accepted.map((r, i) => [i, r] as const))('both accept fixture %i', (_i, input) => {
    expect(() => parseSegmentRules(input)).not.toThrow();
    expect(ajv(input), JSON.stringify(ajv.errors)).toBe(true);
  });

  it.each(cases())('both reject %s', (_name, input) => {
    expect(() => parseSegmentRules(input)).toThrow();
    expect(ajv(input)).toBe(false);
  });

  function cases(): [string, unknown][] {
    return [
      ['an unknown field', rules({ field: 'favourite_colour', op: 'eq', value: 1 })],
      ['a bad operator', rules({ field: 'tags', op: 'gte', value: 'x' })],
      ['an extra key', rules({ field: 'orders_count', op: 'eq', value: 1, weight: 2 })],
      ['the wrong version', { v: 2, all: [] }],
      ['an empty any group', { v: 1, all: [{ any: [] }] }],
      ['the old flat shape', { total_spent_minor: { gte: 50_000 }, consent: ['email'] }],
    ];
  }
});

describe('compiling to SQL', () => {
  it('binds every value as a parameter and never interpolates one', () => {
    const injection = "NL'); DROP TABLE customer; --";
    const compiled = compileSegmentRules(
      parseSegmentRules(rules({ field: 'tags', op: 'includes', value: injection })),
      1,
    );
    expect(compiled.where).not.toContain('DROP TABLE');
    expect(compiled.where).toContain('$2');
    expect(compiled.params).toEqual([injection]);
  });

  it('joins groups with AND and predicates inside a group with OR', () => {
    const compiled = compileSegmentRules(
      parseSegmentRules({
        v: 1,
        all: [
          {
            any: [
              { field: 'orders_count', op: 'gte', value: 2 },
              { field: 'total_spent_minor', op: 'gte', value: 10_000 },
            ],
          },
          { any: [{ field: 'consent', op: 'granted', value: 'email' }] },
        ],
      }),
    );
    expect(compiled.where).toMatch(/\(.+ OR .+\) AND .+/);
    expect(compiled.params).toEqual([2, 10_000, 'marketing_email']);
  });

  it('numbers parameters after the store id the query block already uses', () => {
    const q = segmentQuery(parseSegmentRules(vip), 'c.id');
    expect(q.text).toContain('$1'); // store id, bound by the caller
    expect(q.text).toContain('$2');
    expect(q.params).toEqual([50_000, 'marketing_email']);
  });

  it('keeps predicates total: no-order, no-address and no-tags customers still evaluate', () => {
    const where = compileSegmentRules(
      parseSegmentRules({
        v: 1,
        all: [
          { any: [{ field: 'orders_count', op: 'lte', value: 0 }] },
          { any: [{ field: 'country', op: 'not_in', value: ['NL'] }] },
          { any: [{ field: 'tags', op: 'excludes', value: 'wholesale' }] },
        ],
      }),
    ).where;
    // COALESCE for the aggregate, an explicit NULL branch for the address, a type guard for the jsonb array.
    expect(where).toContain('COALESCE(o.orders_count, 0)');
    expect(where).toContain('addr.country IS NULL');
    expect(where).toContain("jsonb_typeof(c.metadata->'tags') = 'array'");
  });
});
