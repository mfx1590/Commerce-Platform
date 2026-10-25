// Test fixture: a generated month of envelopes over EVERY topic and version of @platform/events, built from the
// schemas themselves (so a new topic is covered the day it lands) and checked with the real validator. Seeded,
// so the same month comes out on every run. Free strings get neutral words ("v-17"), never anything PII-shaped:
// the PII sweep therefore tests the PIPELINE (nothing adds personal data on the way into raw_events), and the
// schemas' own PII guard lives in packages/events.
import {
  COMMON_SCHEMA,
  createValidator,
  ENVELOPE_SCHEMA,
  EVENT_SCHEMAS,
  type EventEnvelopeV1Base,
} from '@platform/events';

type Schema = Record<string, unknown>;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = '0123456789abcdef';

export function sampler(random: () => number) {
  const hex = (n: number) =>
    Array.from({ length: n }, () => HEX[Math.floor(random() * 16)]).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  let counter = 0;
  const common = (COMMON_SCHEMA as unknown as { $defs: Record<string, Schema> }).$defs;

  function resolve(ref: string, root: Schema): Schema {
    const [, pointer] = ref.split('#');
    const base = ref.startsWith('#') ? root : { $defs: common };
    let node: unknown = base;
    for (const part of (pointer ?? '').split('/').filter(Boolean)) {
      node = (node as Record<string, unknown>)[part];
    }
    if (!node) throw new Error(`unresolved $ref ${ref}`);
    return node as Schema;
  }

  function sample(schema: Schema, root: Schema, at = '2026-10-01T00:00:00.000Z'): unknown {
    if (typeof schema.$ref === 'string') return sample(resolve(schema.$ref, root), root, at);
    if (Array.isArray(schema.oneOf)) {
      // prefer the non-null branch most of the time, so the payloads carry their real columns
      const branches = schema.oneOf as Schema[];
      const nonNull = branches.filter((b) => b.type !== 'null');
      const pick = nonNull.length > 0 && random() < 0.8 ? nonNull : branches;
      return sample(pick[Math.floor(random() * pick.length)]!, root, at);
    }
    if ('const' in schema) return schema.const;
    if (Array.isArray(schema.enum)) return schema.enum[Math.floor(random() * schema.enum.length)];
    let type = schema.type;
    if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? 'null';
    switch (type) {
      case 'null':
        return null;
      case 'boolean':
        return random() < 0.5;
      case 'integer':
      case 'number': {
        const min = typeof schema.minimum === 'number' ? schema.minimum : 0;
        const max = typeof schema.maximum === 'number' ? schema.maximum : min + 50_000;
        return min + Math.floor(random() * (max - min + 1));
      }
      case 'string': {
        const pattern = schema.pattern as string | undefined;
        if (pattern?.includes('{12}')) return uuid();
        if (pattern === '^[0-9a-f]{64}$') return hex(64);
        if (pattern === '^[A-Z]{3}$') return ['EUR', 'GBP', 'USD'][Math.floor(random() * 3)];
        if (pattern === '^[A-Z]{2}$') return ['DE', 'GB', 'US', 'FR'][Math.floor(random() * 4)];
        if (pattern) throw new Error(`no sample for pattern ${pattern}`);
        if (schema.format === 'uuid') return uuid();
        if (schema.format === 'date-time') return at;
        if (schema.format === 'uri') return `https://shop.example.test/p/${counter++}`;
        const min = typeof schema.minLength === 'number' ? schema.minLength : 1;
        return `v-${String(counter++).padStart(Math.max(0, min - 2), '0')}`;
      }
      case 'array': {
        const items = (schema.items ?? {}) as Schema;
        const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
        const n = Math.max(min, 1 + Math.floor(random() * 3));
        return Array.from({ length: n }, () => sample(items, root, at));
      }
      case 'object':
      default: {
        const props = (schema.properties ?? {}) as Record<string, Schema>;
        const required = new Set((schema.required as string[] | undefined) ?? []);
        const dependent = (schema.dependentRequired ?? {}) as Record<string, string[]>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (required.has(k) || random() < 0.5) out[k] = sample(v, root, at);
        }
        for (const [k, deps] of Object.entries(dependent)) {
          if (k in out) for (const d of deps) if (!(d in out)) out[d] = sample(props[d]!, root, at);
        }
        return out;
      }
    }
  }
  return { sample, uuid };
}

export const ORGANIZATION = '0a000000-0000-4000-8000-000000000001';
export const STORES = [
  '0a000000-0000-4000-8000-00000000000a',
  '0a000000-0000-4000-8000-00000000000b',
  '0a000000-0000-4000-8000-00000000000c',
] as const;

export interface GeneratedMonth {
  events: EventEnvelopeV1Base[];
  /** `topic@version` → number of events. */
  perKey: Record<string, number>;
}

/** `perKey` events of every known topic@version over October 2026, three stores, validated. */
export function generateMonth(opts: { seed?: number; perKey?: number } = {}): GeneratedMonth {
  const random = rng(opts.seed ?? 42);
  const { sample, uuid } = sampler(random);
  const validator = createValidator();
  const aggregateTypes = (
    ENVELOPE_SCHEMA as unknown as { properties: { aggregate_type: { enum: string[] } } }
  ).properties.aggregate_type.enum;
  const events: EventEnvelopeV1Base[] = [];
  const perKey: Record<string, number> = {};
  for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
    const [topic, v] = key.split('@') as [string, string];
    const entity = topic.split('.')[0]!;
    const aggregateType = aggregateTypes.includes(entity) ? entity : aggregateTypes[0]!;
    for (let i = 0; i < (opts.perKey ?? 5); i++) {
      const day = 1 + Math.floor(random() * 31);
      const at = `2026-10-${String(day).padStart(2, '0')}T${String(Math.floor(random() * 24)).padStart(2, '0')}:00:00.000Z`;
      const envelope = {
        event_id: uuid(),
        topic,
        version: Number(v),
        occurred_at: at,
        organization_id: ORGANIZATION,
        store_id: STORES[Math.floor(random() * STORES.length)]!,
        aggregate_type: aggregateType,
        aggregate_id: uuid(),
        actor: { type: 'system', id: null },
        payload: sample(schema as unknown as Schema, schema as unknown as Schema, at),
      } as unknown as EventEnvelopeV1Base;
      const check = validator.validateEnvelope(envelope);
      if (!check.ok) throw new Error(`generated ${key} is invalid: ${check.errors.join('; ')}`);
      events.push(envelope);
      perKey[key] = (perKey[key] ?? 0) + 1;
    }
  }
  return { events, perKey };
}
