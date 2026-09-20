// The segment rule grammar — frozen here in Phase 2.3 (#147), as `SegmentRules` in the contract said it would be.
//
//     { v: 1, all: [ { any: [predicate, …] }, … ] }
//
// An AND of ORs: every group in `all` must be satisfied, and a group is satisfied by any one of its predicates.
// That is enough for every segment the scope document asks for and small enough to compile to SQL and to explain
// in a UI. Nesting deeper buys expressiveness nobody asked for and a rule builder nobody can draw.
//
// **The predicate set is closed and unknown input is rejected with 400** (manager decision 2026-09-19). A segment
// that silently ignores a rule it does not understand is worse than one that refuses to save: the first sends the
// wrong campaign to the wrong people and nobody finds out, the second is a validation message. This is the
// deliberate opposite of the contract's current "Unknown keys are kept, not rejected" — see the CONTRACT CHANGE.
//
// `SEGMENT_RULES_SCHEMA` is published from the module's index.ts so window 16 and the admin can validate rules
// without importing this module or duplicating the grammar.
import { validationError } from '../../lib/errors';

export const SEGMENT_RULES_VERSION = 1;

export type SegmentField =
  | 'orders_count'
  | 'total_spent_minor'
  | 'last_order_at'
  | 'tags'
  | 'consent'
  | 'country'
  | 'customer_group_ids';

export type ConsentChannel = 'email' | 'sms';

export type SegmentPredicate =
  | { field: 'orders_count'; op: 'gte' | 'lte' | 'eq'; value: number }
  | { field: 'total_spent_minor'; op: 'gte' | 'lte' | 'eq'; value: number }
  | { field: 'last_order_at'; op: 'after' | 'before'; value: string }
  | { field: 'tags'; op: 'includes' | 'excludes'; value: string }
  | { field: 'consent'; op: 'granted' | 'not_granted'; value: ConsentChannel }
  | { field: 'country'; op: 'in' | 'not_in'; value: string[] }
  | { field: 'customer_group_ids'; op: 'in' | 'not_in'; value: string[] };

export interface SegmentAnyGroup {
  any: SegmentPredicate[];
}

export interface SegmentRules {
  v: typeof SEGMENT_RULES_VERSION;
  all: SegmentAnyGroup[];
}

/** Everyone in the store: no constraints. `all: []` is legal and is what a new segment starts as. */
export const EMPTY_RULES: SegmentRules = { v: SEGMENT_RULES_VERSION, all: [] };

type ValueKind = 'integer' | 'timestamp' | 'string' | 'consent' | 'country_list' | 'uuid_list';

interface FieldSpec {
  ops: readonly string[];
  value: ValueKind;
}

/** The closed set. Adding a field here is an additive contract change, never a silent extension. */
export const SEGMENT_FIELDS: Record<SegmentField, FieldSpec> = {
  orders_count: { ops: ['gte', 'lte', 'eq'], value: 'integer' },
  total_spent_minor: { ops: ['gte', 'lte', 'eq'], value: 'integer' },
  last_order_at: { ops: ['after', 'before'], value: 'timestamp' },
  tags: { ops: ['includes', 'excludes'], value: 'string' },
  consent: { ops: ['granted', 'not_granted'], value: 'consent' },
  country: { ops: ['in', 'not_in'], value: 'country_list' },
  customer_group_ids: { ops: ['in', 'not_in'], value: 'uuid_list' },
};

export const CONSENT_CHANNELS: readonly ConsentChannel[] = ['email', 'sms'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_LIST = 200;

function fail(path: string, message: string): never {
  throw validationError('invalid segment rules', { [path]: message });
}

function keysExactly(value: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${path}.${key}`, `unknown key (allowed: ${allowed.join(', ')})`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseValue(kind: ValueKind, raw: unknown, path: string): SegmentPredicate['value'] {
  switch (kind) {
    case 'integer':
      if (!Number.isInteger(raw)) fail(path, 'integer');
      return raw as number;
    case 'timestamp': {
      if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw)))
        fail(path, 'RFC-3339 timestamp');
      return new Date(Date.parse(raw as string)).toISOString();
    }
    case 'string': {
      if (typeof raw !== 'string' || raw.trim() === '') fail(path, 'non-empty string');
      return (raw as string).trim();
    }
    case 'consent':
      if (typeof raw !== 'string' || !CONSENT_CHANNELS.includes(raw as ConsentChannel)) {
        fail(path, `one of ${CONSENT_CHANNELS.join(', ')}`);
      }
      return raw as ConsentChannel;
    case 'country_list': {
      if (!Array.isArray(raw) || raw.length === 0)
        fail(path, 'non-empty array of ISO-3166-1 alpha-2 codes');
      if (raw.length > MAX_LIST) fail(path, `at most ${MAX_LIST} entries`);
      return raw.map((c, i) => {
        if (typeof c !== 'string' || !COUNTRY.test(c))
          fail(`${path}[${i}]`, 'ISO-3166-1 alpha-2, upper case');
        return c as string;
      });
    }
    case 'uuid_list': {
      if (!Array.isArray(raw) || raw.length === 0) fail(path, 'non-empty array of uuids');
      if (raw.length > MAX_LIST) fail(path, `at most ${MAX_LIST} entries`);
      return raw.map((id, i) => {
        if (typeof id !== 'string' || !UUID.test(id)) fail(`${path}[${i}]`, 'uuid');
        return id as string;
      });
    }
  }
}

function parsePredicate(raw: unknown, path: string): SegmentPredicate {
  if (!isPlainObject(raw)) fail(path, 'object { field, op, value }');
  keysExactly(raw, ['field', 'op', 'value'], path);

  const field = raw.field;
  if (typeof field !== 'string' || !(field in SEGMENT_FIELDS)) {
    fail(`${path}.field`, `one of ${Object.keys(SEGMENT_FIELDS).join(', ')}`);
  }
  const spec = SEGMENT_FIELDS[field as SegmentField];

  const op = raw.op;
  if (typeof op !== 'string' || !spec.ops.includes(op)) {
    fail(`${path}.op`, `one of ${spec.ops.join(', ')} for ${field}`);
  }
  if (!('value' in raw)) fail(`${path}.value`, 'required');

  return {
    field,
    op,
    value: parseValue(spec.value, raw.value, `${path}.value`),
  } as SegmentPredicate;
}

/**
 * Validates and normalises rules from the wire. Throws `AppError('validation_error')` naming the exact path of
 * the first problem (`all[0].any[2].op`), so the admin can point at the offending row instead of saying "invalid".
 *
 * Accepts `null` / `undefined` / `{}` as "no constraints" — a segment always has rules, and an empty rule set
 * legitimately means every customer of the store.
 */
export function parseSegmentRules(raw: unknown): SegmentRules {
  if (raw === null || raw === undefined) return { ...EMPTY_RULES, all: [] };
  if (!isPlainObject(raw)) fail('rules', 'object { v, all }');
  if (Object.keys(raw).length === 0) return { ...EMPTY_RULES, all: [] };

  keysExactly(raw, ['v', 'all'], 'rules');
  if (raw.v !== SEGMENT_RULES_VERSION) {
    fail('rules.v', `must be ${SEGMENT_RULES_VERSION}`);
  }
  if (!Array.isArray(raw.all)) fail('rules.all', 'array of { any: [...] }');

  const all = raw.all.map((group, gi): SegmentAnyGroup => {
    const path = `rules.all[${gi}]`;
    if (!isPlainObject(group)) fail(path, 'object { any: [...] }');
    keysExactly(group, ['any'], path);
    if (!Array.isArray(group.any) || group.any.length === 0) {
      // An empty OR matches nobody, which is never what someone meant to save.
      fail(`${path}.any`, 'non-empty array of predicates');
    }
    return { any: group.any.map((p, pi) => parsePredicate(p, `${path}.any[${pi}]`)) };
  });

  return { v: SEGMENT_RULES_VERSION, all };
}

/**
 * The same grammar as a JSON Schema (2020-12), published from the module's index.ts. Window 16's messaging worker
 * and the admin rule builder validate against this rather than re-deriving the grammar — one definition, three
 * consumers. `additionalProperties: false` everywhere is the point: it is what makes the set closed.
 */
export const SEGMENT_RULES_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.commerce-platform.dev/marketing/segment-rules/v1.json',
  title: 'SegmentRules v1',
  description:
    'AND of ORs over a closed predicate set. Every group in `all` must match; a group matches when any of its predicates does. An empty `all` matches every customer of the store.',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'all'],
  properties: {
    v: { const: SEGMENT_RULES_VERSION },
    all: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['any'],
        properties: {
          any: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/$defs/predicate' },
          },
        },
      },
    },
  },
  $defs: {
    predicate: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'op', 'value'],
          properties: {
            field: { enum: ['orders_count', 'total_spent_minor'] },
            op: { enum: ['gte', 'lte', 'eq'] },
            value: { type: 'integer' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'op', 'value'],
          properties: {
            field: { const: 'last_order_at' },
            op: { enum: ['after', 'before'] },
            value: { type: 'string', format: 'date-time' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'op', 'value'],
          properties: {
            field: { const: 'tags' },
            op: { enum: ['includes', 'excludes'] },
            value: { type: 'string', minLength: 1 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'op', 'value'],
          properties: {
            field: { const: 'consent' },
            op: { enum: ['granted', 'not_granted'] },
            value: { enum: ['email', 'sms'] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'op', 'value'],
          properties: {
            field: { const: 'country' },
            op: { enum: ['in', 'not_in'] },
            value: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_LIST,
              items: { type: 'string', pattern: '^[A-Z]{2}$' },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'op', 'value'],
          properties: {
            field: { const: 'customer_group_ids' },
            op: { enum: ['in', 'not_in'] },
            value: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_LIST,
              items: { type: 'string', format: 'uuid' },
            },
          },
        },
      ],
    },
  },
} as const;
