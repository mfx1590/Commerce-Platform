// Merchandising rules (task 2.2, #135): types mirroring the proposed contract (proposed/admin-api.merchandising.yaml)
// and the body validation the router runs until the contract lands and `spec().validateBody` can take over.
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validationError } from '../../lib/errors';

export type MerchandisingScope =
  | { type: 'category'; category_id: string; query?: null }
  | { type: 'query'; query: string; category_id?: null };

export interface MerchandisingBoost {
  product_id: string;
  weight: number;
}

export interface MerchandisingRuleInput {
  scope: { type: 'category' | 'query'; category_id?: string | null; query?: string | null };
  pins?: string[];
  boosts?: MerchandisingBoost[];
  buries?: string[];
  enabled?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
}

export interface MerchandisingRulePatch {
  pins?: string[];
  boosts?: MerchandisingBoost[];
  buries?: string[];
  enabled?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
}

/** Contract shape (`MerchandisingRule`) plus `store_id` for internal checks (stripped by the router). */
export interface MerchandisingRule {
  id: string;
  store_id: string;
  scope: MerchandisingScope;
  pins: string[];
  boosts: MerchandisingBoost[];
  buries: string[];
  enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublishResult {
  index: string;
  published: number;
  skipped: number;
}

// ---- JSON schemas (same as the proposed YAML; keep both in sync) ----------------------------------------------

const uuid = { type: 'string', format: 'uuid' } as const;
const boost = {
  type: 'object',
  required: ['product_id', 'weight'],
  additionalProperties: false,
  properties: { product_id: uuid, weight: { type: 'integer', minimum: 1, maximum: 100 } },
} as const;
const lists = {
  pins: { type: 'array', maxItems: 50, items: uuid },
  boosts: { type: 'array', maxItems: 200, items: boost },
  buries: { type: 'array', maxItems: 200, items: uuid },
  enabled: { type: 'boolean' },
  starts_at: { type: ['string', 'null'], format: 'date-time' },
  ends_at: { type: ['string', 'null'], format: 'date-time' },
} as const;

export const MERCHANDISING_RULE_INPUT_SCHEMA = {
  type: 'object',
  required: ['scope'],
  additionalProperties: false,
  properties: {
    scope: {
      type: 'object',
      required: ['type'],
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['category', 'query'] },
        category_id: { type: ['string', 'null'], format: 'uuid' },
        query: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      },
    },
    ...lists,
  },
} as const;

export const MERCHANDISING_RULE_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...lists },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateInput = ajv.compile(MERCHANDISING_RULE_INPUT_SCHEMA);
const validatePatch = ajv.compile(MERCHANDISING_RULE_PATCH_SCHEMA);

function problems(errors: ErrorObject[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors ?? []) out[e.instancePath || '/'] = e.message ?? 'invalid';
  return out;
}

/** Normalises a query scope key: trimmed, single-spaced, lower-cased (one rule per store + scope). */
export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Schema + cross-field validation of a create body; returns the typed input with a normalised scope. */
export function parseRuleInput(
  body: unknown,
): MerchandisingRuleInput & { scope: MerchandisingScope } {
  if (!validateInput(body))
    throw validationError('invalid merchandising rule', problems(validateInput.errors));
  const input = body as MerchandisingRuleInput;
  const scope = parseScope(input.scope);
  assertLists(input);
  return { ...input, scope };
}

export function parsePatch(body: unknown): MerchandisingRulePatch {
  if (!validatePatch(body))
    throw validationError('invalid merchandising rule patch', problems(validatePatch.errors));
  const patch = body as MerchandisingRulePatch;
  assertLists(patch);
  return patch;
}

function parseScope(scope: MerchandisingRuleInput['scope']): MerchandisingScope {
  if (scope.type === 'category') {
    if (!scope.category_id)
      throw validationError('scope.category_id is required for a category scope', {
        '/scope/category_id': 'required',
      });
    return { type: 'category', category_id: scope.category_id };
  }
  const query = scope.query ? normalizeQuery(scope.query) : '';
  if (!query)
    throw validationError('scope.query is required for a query scope', {
      '/scope/query': 'required',
    });
  return { type: 'query', query };
}

/** No duplicates inside a list, no product both pinned and buried, a valid date window. */
export function assertLists(x: MerchandisingRulePatch): void {
  const details: Record<string, string> = {};
  const dup = (ids: string[]) => ids.length !== new Set(ids).size;
  if (x.pins && dup(x.pins)) details['/pins'] = 'duplicate product ids';
  if (x.buries && dup(x.buries)) details['/buries'] = 'duplicate product ids';
  if (x.boosts && dup(x.boosts.map((b) => b.product_id)))
    details['/boosts'] = 'duplicate product ids';
  if (x.pins && x.buries) {
    const buried = new Set(x.buries);
    if (x.pins.some((id) => buried.has(id)))
      details['/buries'] = 'a pinned product cannot be buried';
  }
  if (x.starts_at && x.ends_at && new Date(x.ends_at) <= new Date(x.starts_at))
    details['/ends_at'] = 'must be after starts_at';
  if (Object.keys(details).length > 0) throw validationError('invalid merchandising rule', details);
}

/** Every product id a rule references (pins, boosts, buries), de-duplicated. */
export function referencedProductIds(x: MerchandisingRulePatch): string[] {
  return [
    ...new Set([
      ...(x.pins ?? []),
      ...(x.buries ?? []),
      ...(x.boosts ?? []).map((b) => b.product_id),
    ]),
  ];
}

/** Whether the rule applies at `now` (enabled and inside its window). */
export function isRuleActive(rule: MerchandisingRule, now: Date): boolean {
  if (!rule.enabled) return false;
  if (rule.starts_at && new Date(rule.starts_at) > now) return false;
  if (rule.ends_at && new Date(rule.ends_at) <= now) return false;
  return true;
}
