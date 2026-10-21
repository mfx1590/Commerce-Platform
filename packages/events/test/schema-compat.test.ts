// The offline BACKWARD gate (#532): the checker's rules on fixtures, and every schema file against the published
// lock (a published version that changed incompatibly fails CI here, with no registry involved).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  backwardIncompatibilities,
  buildLock,
  canonicalJson,
  compareWithLock,
  COMMON_SCHEMA,
  currentLockEntries,
  EVENT_SCHEMAS,
  explainVerdict,
  inlineCommonRefs,
  isBackwardCompatible,
  registrySchemas,
  schemaDigest,
  subjectFor,
  type SchemaLock,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const lockPath = resolve(here, '../schemas/published.lock.json');

const base = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['draft', 'live'] },
    amount: { type: 'integer', minimum: 0 },
    note: { type: ['string', 'null'] },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku'],
        properties: { sku: { type: 'string' }, qty: { type: 'integer' } },
      },
    },
    ref: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
};
const edit = (fn: (s: typeof base) => void): typeof base => {
  const s = JSON.parse(JSON.stringify(base)) as typeof base;
  fn(s);
  return s;
};
const rules = (n: unknown) => backwardIncompatibilities(base, n).map((i) => `${i.rule}@${i.path}`);

describe('backwardIncompatibilities (our own BACKWARD rules)', () => {
  it('identical and additive changes are compatible', () => {
    expect(rules(base)).toEqual([]);
    expect(
      rules(edit((s) => ((s.properties as Record<string, unknown>).extra = { type: 'string' }))),
    ).toEqual([]);
    expect(rules(edit((s) => s.properties.status.enum.push('archived')))).toEqual([]);
    expect(
      rules(edit((s) => delete (s.properties.amount as { minimum?: number }).minimum)),
    ).toEqual([]);
    expect(rules(edit((s) => (s.required = ['id'])))).toEqual([]); // a required field becoming optional
    expect(rules(edit((s) => (s.properties.amount.type = ['integer', 'null'] as never)))).toEqual(
      [],
    );
    expect(rules(edit((s) => s.properties.ref.oneOf.push({ type: 'integer' })))).toEqual([]);
  });

  it('a REQUIRED property added is breaking (the registry misses this one)', () => {
    expect(
      rules(
        edit((s) => {
          (s.properties as Record<string, unknown>).extra = { type: 'string' };
          s.required.push('extra');
        }),
      ),
    ).toEqual(['REQUIRED_ADDED@#/required']);
  });

  it('a property removed under a closed content model is breaking; under an open one it is not', () => {
    expect(rules(edit((s) => delete (s.properties as Record<string, unknown>).amount))).toEqual([
      'PROPERTY_REMOVED@#/properties/amount',
    ]);
    const open = edit((s) => ((s as Record<string, unknown>).additionalProperties = true));
    const openWithout = edit((s) => {
      (s as Record<string, unknown>).additionalProperties = true;
      delete (s.properties as Record<string, unknown>).amount;
    });
    expect(backwardIncompatibilities(open, openWithout)).toEqual([]);
    expect(backwardIncompatibilities(open, base).map((i) => i.rule)).toEqual([
      'CONTENT_MODEL_CLOSED',
    ]);
  });

  it('type narrowed, enum narrowed or introduced, const changed, bounds tightened, pattern/format changed', () => {
    expect(rules(edit((s) => (s.properties.note.type = 'string' as never)))).toEqual([
      'TYPE_NARROWED@#/properties/note',
    ]);
    expect(rules(edit((s) => (s.properties.status.enum = ['draft'])))).toEqual([
      'ENUM_NARROWED@#/properties/status',
    ]);
    expect(rules(edit((s) => ((s.properties.id as Record<string, unknown>).enum = ['a'])))).toEqual(
      ['ENUM_NARROWED@#/properties/id'],
    );
    expect(rules(edit((s) => ((s.properties.id as Record<string, unknown>).const = 'a')))).toEqual([
      'CONST_CHANGED@#/properties/id',
    ]);
    expect(rules(edit((s) => (s.properties.amount.minimum = 1)))).toEqual([
      'BOUND_TIGHTENED@#/properties/amount',
    ]);
    expect(
      rules(edit((s) => ((s.properties.amount as Record<string, unknown>).maximum = 10))),
    ).toEqual(['BOUND_TIGHTENED@#/properties/amount']);
    expect(
      rules(edit((s) => ((s.properties.id as Record<string, unknown>).pattern = '^a'))),
    ).toEqual(['PATTERN_CHANGED@#/properties/id']);
    expect(rules(edit((s) => (s.properties.id.format = 'email')))).toEqual([
      'FORMAT_CHANGED@#/properties/id',
    ]);
    expect(
      rules(edit((s) => ((s.properties.lines as Record<string, unknown>).minItems = 1))),
    ).toEqual(['BOUND_TIGHTENED@#/properties/lines']);
  });

  it('recurses into items and alternatives', () => {
    expect(rules(edit((s) => s.properties.lines.items.required.push('qty')))).toEqual([
      'REQUIRED_ADDED@#/properties/lines/items/required',
    ]);
    expect(rules(edit((s) => (s.properties.ref.oneOf = [{ type: 'string' }])))).toEqual([
      'ALTERNATIVE_REMOVED@#/properties/ref/oneOf/1',
    ]);
    // old plain schema → new oneOf that still accepts it
    expect(
      backwardIncompatibilities(
        { type: 'string' },
        { oneOf: [{ type: 'string' }, { type: 'null' }] },
      ),
    ).toEqual([]);
    expect(
      backwardIncompatibilities({ type: 'string' }, { oneOf: [{ type: 'integer' }] }).map(
        (i) => i.rule,
      ),
    ).toEqual(['ALTERNATIVE_REMOVED']);
    expect(isBackwardCompatible(base, base)).toBe(true);
  });

  it('dependentRequired: a new dependency or a new name under one is breaking; allOf recurses and an added conjunct is breaking', () => {
    const withDep = edit(
      (s) => ((s as Record<string, unknown>).dependentRequired = { note: ['amount'] }),
    );
    expect(backwardIncompatibilities(base, withDep).map((i) => i.rule)).toEqual([
      'DEPENDENT_REQUIRED_ADDED',
    ]);
    const widerDep = edit(
      (s) => ((s as Record<string, unknown>).dependentRequired = { note: ['amount', 'status'] }),
    );
    expect(
      backwardIncompatibilities(withDep, widerDep).map((i) => `${i.rule}:${i.detail}`),
    ).toEqual(['DEPENDENT_REQUIRED_ADDED:note → ["status"]']);
    expect(backwardIncompatibilities(widerDep, withDep)).toEqual([]); // a dependency dropped is fine
    const allOf = {
      allOf: [{ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }],
    };
    expect(
      backwardIncompatibilities(allOf, {
        allOf: [
          {
            type: 'object',
            required: ['a'],
            properties: { a: { type: 'string' }, b: { type: 'string' } },
          },
        ],
      }),
    ).toEqual([]);
    expect(
      backwardIncompatibilities(allOf, {
        allOf: [
          {
            type: 'object',
            required: ['a', 'b'],
            properties: { a: { type: 'string' }, b: { type: 'string' } },
          },
        ],
      }).map((i) => i.rule),
    ).toEqual(['REQUIRED_ADDED']);
    expect(
      backwardIncompatibilities(allOf, { allOf: [...allOf.allOf, { type: 'object' }] }).map(
        (i) => `${i.rule}@${i.path}`,
      ),
    ).toEqual(['ALL_OF_NARROWED@#/allOf/1']);
  });

  it('a keyword the checker does not understand is breaking when it appears or changes, and ignored when unchanged', () => {
    const withIf = edit(
      (s) => ((s as Record<string, unknown>).if = { properties: { status: { const: 'live' } } }),
    );
    expect(backwardIncompatibilities(base, withIf).map((i) => `${i.rule}@${i.path}`)).toEqual([
      'UNKNOWN_KEYWORD@#/if',
    ]);
    expect(backwardIncompatibilities(withIf, withIf)).toEqual([]);
    const nested = edit(
      (s) => ((s.properties.id as Record<string, unknown>).patternProperties = {}),
    );
    expect(backwardIncompatibilities(base, nested).map((i) => i.path)).toEqual([
      '#/properties/id/patternProperties',
    ]);
    // the real stock.moved v2 uses dependentRequired: its change against v1 is named, not silently accepted
    const v1 = inlineCommonRefs(EVENT_SCHEMAS['stock.moved@1']);
    const v2 = inlineCommonRefs(EVENT_SCHEMAS['stock.moved@2']);
    expect(backwardIncompatibilities(v1, v2).map((i) => i.rule)).toContain(
      'DEPENDENT_REQUIRED_ADDED',
    );
  });

  it('our real v2s are NOT backward compatible with their v1 — by design, a new version is a new file', () => {
    const v1 = inlineCommonRefs(EVENT_SCHEMAS['stock.moved@1']);
    const v2 = inlineCommonRefs(EVENT_SCHEMAS['stock.moved@2']);
    expect(backwardIncompatibilities(v1, v2).map((i) => i.rule)).toContain('REQUIRED_ADDED');
    const e1 = inlineCommonRefs(EVENT_SCHEMAS['customer.export_requested@1']);
    const e2 = inlineCommonRefs(EVENT_SCHEMAS['customer.export_requested@2']);
    expect(backwardIncompatibilities(e1, e2).map((i) => `${i.rule}:${i.detail}`)).toEqual([
      'REQUIRED_ADDED:requested_by_type',
    ]);
  });
});

describe('inlineCommonRefs / canonical form', () => {
  it('replaces every common $ref with its definition and leaves no $ref behind', () => {
    for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
      const inlined = inlineCommonRefs(schema);
      expect(JSON.stringify(inlined), key).not.toContain('"$ref"');
      expect(JSON.stringify(inlined), key).toContain('"pattern"'); // the uuid def arrived
    }
    const defs = (COMMON_SCHEMA as unknown as { $defs: Record<string, unknown> }).$defs;
    expect(
      inlineCommonRefs({
        a: { $ref: 'https://schemas.commerce-platform.dev/events/common/v1.json#/$defs/uuid' },
      }),
    ).toEqual({ a: defs.uuid });
    expect(() => inlineCommonRefs({ $ref: '#/other' })).toThrow(/unsupported \$ref/);
    expect(() =>
      inlineCommonRefs({
        $ref: 'https://schemas.commerce-platform.dev/events/common/v1.json#/$defs/nope',
      }),
    ).toThrow(/unknown common definition/);
  });

  it('canonical JSON sorts keys at every level, so the digest ignores key order and whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(schemaDigest({ a: 1, b: 2 })).toBe(schemaDigest({ b: 2, a: 1 }));
    expect(schemaDigest({ a: 1 })).not.toBe(schemaDigest({ a: 2 }));
  });

  it('registrySchemas: one inlined entry per topic@version with the per-version subject name', () => {
    const all = registrySchemas();
    expect(all).toHaveLength(Object.keys(EVENT_SCHEMAS).length);
    const placed = all.find((s) => s.topic === 'order.placed')!;
    expect(placed).toMatchObject({ version: 1, subject: 'order.placed-v1-value' });
    expect(subjectFor('stock.moved', 2, 't-x.')).toBe('t-x.stock.moved-v2-value');
    expect(all.filter((s) => s.topic === 'stock.moved').map((s) => s.subject)).toEqual([
      'stock.moved-v1-value',
      'stock.moved-v2-value',
    ]);
  });
});

describe('schemas/published.lock.json — the CI gate for published versions', () => {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as SchemaLock;

  it('every schema file matches its published copy (a changed or missing one tells you what to do)', () => {
    const verdicts = compareWithLock(lock);
    const problems = verdicts.filter((v) => v.state !== 'unchanged').map(explainVerdict);
    expect(problems, problems.join('\n')).toEqual([]);
    expect(verdicts).toHaveLength(Object.keys(EVENT_SCHEMAS).length);
  });

  it('a published version edited incompatibly is reported as breaking with the rule; compatibly as needing an explicit lock; a new version as new', () => {
    const current = currentLockEntries();
    const key = 'order.placed@1';
    const breaking = JSON.parse(JSON.stringify(current)) as typeof current;
    (breaking[key]!.schema as { required: string[] }).required.push('brand_new_required');
    breaking[key]!.sha256 = schemaDigest(breaking[key]!.schema);
    const vb = compareWithLock(lock, breaking).find((v) => v.key === key)!;
    expect(vb.state).toBe('changed_breaking');
    expect(explainVerdict(vb)).toMatch(
      /NOT backward compatible — REQUIRED_ADDED at #\/required: brand_new_required/,
    );

    const compatible = JSON.parse(JSON.stringify(current)) as typeof current;
    (
      compatible[key]!.schema as { properties: Record<string, unknown> }
    ).properties.brand_new_optional = { type: 'string' };
    compatible[key]!.sha256 = schemaDigest(compatible[key]!.schema);
    const vc = compareWithLock(lock, compatible).find((v) => v.key === key)!;
    expect(vc.state).toBe('changed_compatible');
    expect(explainVerdict(vc)).toMatch(/schemas:lock/);

    const added = { ...current, 'order.placed@2': current[key]! };
    expect(compareWithLock(lock, added).find((v) => v.key === 'order.placed@2')?.state).toBe('new');
    expect(compareWithLock(null).every((v) => v.state === 'new')).toBe(true);
  });

  it("every lock entry's sha256 is the digest of its own schema (a sloppy hand edit fails here; a consistent one is for review)", () => {
    for (const [key, entry] of Object.entries(lock.schemas)) {
      expect(entry.sha256, key).toBe(schemaDigest(entry.schema));
      expect(canonicalJson(entry.schema), key).toBe(JSON.stringify(entry.schema)); // stored in canonical form
    }
  });

  it('buildLock refuses a breaking change and a removed version; accepts the current files', () => {
    const { lock: rebuilt, verdicts } = buildLock(lock);
    expect(rebuilt.schemas).toEqual(lock.schemas);
    expect(verdicts.every((v) => v.state === 'unchanged')).toBe(true);
    const tampered = JSON.parse(JSON.stringify(lock)) as SchemaLock;
    // pretend the published order.placed@1 had one more required field than the file now has
    (tampered.schemas['order.placed@1']!.schema as { required: string[] }).required.push(
      'was_required',
    );
    tampered.schemas['order.placed@1']!.sha256 = 'x';
    expect(() => buildLock(tampered)).not.toThrow(); // dropping a required field is compatible
    const removed = JSON.parse(JSON.stringify(lock)) as SchemaLock;
    removed.schemas['order.placed@9'] = removed.schemas['order.placed@1']!;
    expect(() => buildLock(removed)).toThrow(/order\.placed@9: a published version was deleted/);
    const breaking = JSON.parse(JSON.stringify(lock)) as SchemaLock;
    delete (breaking.schemas['order.placed@1']!.schema as { properties: Record<string, unknown> })
      .properties.order_id;
    breaking.schemas['order.placed@1']!.sha256 = 'y';
    // the file has order_id, the "published" copy did not: the file ADDED a property… that is compatible; make it breaking the other way
    expect(() => buildLock(breaking)).not.toThrow();
    const narrowed = JSON.parse(JSON.stringify(lock)) as SchemaLock;
    (
      narrowed.schemas['order.placed@1']!.schema as {
        properties: { currency: { enum?: string[] } };
      }
    ).properties.currency = { enum: ['EUR', 'GBP', 'USD', 'ZZZ'] } as never;
    narrowed.schemas['order.placed@1']!.sha256 = 'z';
    expect(() => buildLock(narrowed)).toThrow(/schemas:lock refused/);
  });
});
