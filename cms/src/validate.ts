/**
 * A test-time validator that runs the schemas' own `validation` callbacks against a document.
 *
 * Sanity evaluates these rules inside the Studio and on the Studio's validation API; there is no
 * server-side enforcement on the content API. This module lets the fixtures, the seed script and
 * later the storefront's tests prove a document satisfies the schema without a Studio: the same
 * callbacks run against a `RecordingRule` that captures the chain (`required().max(70)`), and
 * `validateDocument` evaluates the captured constraints while walking fields, nested objects and
 * arrays through the schema registry.
 *
 * Coverage is deliberately the subset used by our schemas (see `Rule` in `schema/define.ts`);
 * the Studio remains the authority on anything beyond it.
 */

import type {
  ArrayMemberDefinition,
  BaseDefinition,
  CustomValidator,
  Rule,
  TypeDefinition,
  ValidationClient,
  ValidationContext,
} from './schema/define.js';
import { BUILTIN_TYPES } from './schema/define.js';

type Constraint =
  | { kind: 'required' }
  | { kind: 'min'; value: number }
  | { kind: 'max'; value: number }
  | { kind: 'regex'; pattern: RegExp; name?: string | undefined; invert: boolean }
  | { kind: 'uri'; allowRelative: boolean; scheme: (string | RegExp)[] }
  | { kind: 'unique' }
  | { kind: 'custom'; validator: CustomValidator };

export class RecordingRule implements Rule {
  // Immutable like Sanity's Rule: every call returns a new rule, so `[rule.required(), rule.min(1)]`
  // records two independent chains rather than one shared object.
  constructor(
    readonly constraints: readonly Constraint[] = [],
    readonly level: 'error' | 'warning' = 'error',
    readonly message: string | undefined = undefined,
  ) {}

  private with(constraint: Constraint): this {
    return new RecordingRule([...this.constraints, constraint], this.level, this.message) as this;
  }

  required(): this {
    return this.with({ kind: 'required' });
  }
  min(value: number): this {
    return this.with({ kind: 'min', value });
  }
  max(value: number): this {
    return this.with({ kind: 'max', value });
  }
  regex(pattern: RegExp, options?: { name?: string; invert?: boolean }): this {
    return this.with({
      kind: 'regex',
      pattern,
      name: options?.name,
      invert: options?.invert ?? false,
    });
  }
  uri(options?: { scheme?: (string | RegExp)[]; allowRelative?: boolean }): this {
    return this.with({
      kind: 'uri',
      allowRelative: options?.allowRelative ?? false,
      scheme: options?.scheme ?? ['http', 'https'],
    });
  }
  unique(): this {
    return this.with({ kind: 'unique' });
  }
  custom(validator: CustomValidator): this {
    return this.with({ kind: 'custom', validator });
  }
  error(message?: string): this {
    return new RecordingRule(this.constraints, 'error', message) as this;
  }
  warning(message?: string): this {
    return new RecordingRule(this.constraints, 'warning', message) as this;
  }
}

/** Runs a definition's `validation` callback and returns the recorded rules (possibly several). */
export function collectRules(definition: BaseDefinition): RecordingRule[] {
  if (!definition.validation) return [];
  const result = definition.validation(new RecordingRule());
  return Array.isArray(result) ? result : [result];
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidateOptions {
  /** Injected into custom validators as `context.getClient` (uniqueness checks). */
  getClient?: ((options: { apiVersion: string }) => ValidationClient) | undefined;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record['_type'] === 'slug') return isEmpty(record['current']);
    return Object.keys(record).filter((key) => !key.startsWith('_')).length === 0;
  }
  return false;
}

function size(value: unknown): number | undefined {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (typeof value === 'number') return value;
  return undefined;
}

function isUri(value: string, allowRelative: boolean, scheme: (string | RegExp)[]): boolean {
  if (allowRelative && value.startsWith('/') && !value.startsWith('//')) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const protocol = url.protocol.replace(/:$/, '');
  return scheme.some((s) => (typeof s === 'string' ? s === protocol : s.test(protocol)));
}

async function checkRule(
  rule: RecordingRule,
  value: unknown,
  path: string,
  context: ValidationContext,
  errors: ValidationError[],
): Promise<void> {
  if (rule.level === 'warning') return;
  const fail = (fallback: string) => errors.push({ path, message: rule.message ?? fallback });

  for (const constraint of rule.constraints) {
    switch (constraint.kind) {
      case 'required':
        if (isEmpty(value)) fail('Required');
        break;
      case 'min': {
        const n = size(value);
        if (n !== undefined && n < constraint.value) fail(`Must be at least ${constraint.value}`);
        break;
      }
      case 'max': {
        const n = size(value);
        if (n !== undefined && n > constraint.value) fail(`Must be at most ${constraint.value}`);
        break;
      }
      case 'regex':
        if (typeof value === 'string') {
          const matches = constraint.pattern.test(value);
          if (matches === constraint.invert) {
            fail(
              constraint.invert
                ? `Must not match ${constraint.name ?? constraint.pattern}`
                : `Must match ${constraint.name ?? constraint.pattern}`,
            );
          }
        }
        break;
      case 'uri':
        if (
          typeof value === 'string' &&
          !isUri(value, constraint.allowRelative, constraint.scheme)
        ) {
          fail('Must be a valid URL');
        }
        break;
      case 'unique':
        if (Array.isArray(value)) {
          const seen = new Set<string>();
          for (const item of value) {
            const key = JSON.stringify(item, (k, v: unknown) => (k === '_key' ? undefined : v));
            if (seen.has(key)) {
              fail('Must contain unique items');
              break;
            }
            seen.add(key);
          }
        }
        break;
      case 'custom': {
        const result = await constraint.validator(value, context);
        if (result !== true) fail(typeof result === 'string' ? result : result.message);
        break;
      }
    }
  }
}

class Walker {
  private readonly registry: Map<string, TypeDefinition>;

  constructor(
    schema: readonly TypeDefinition[],
    private readonly document: Record<string, unknown>,
    private readonly options: ValidateOptions,
  ) {
    this.registry = new Map(schema.map((type) => [type.name, type]));
  }

  readonly errors: ValidationError[] = [];

  async value(
    definition: BaseDefinition,
    value: unknown,
    path: string,
    parent: unknown,
    seen: Set<string> = new Set(),
  ): Promise<void> {
    const context: ValidationContext = {
      document: this.document,
      parent,
      path: path ? path.split('.') : [],
      getClient: this.options.getClient,
    };
    for (const rule of collectRules(definition)) {
      await checkRule(rule, value, path, context, this.errors);
    }

    // Resolve a named type (`type: 'hero'`) and validate its own fields against the same value.
    if (!BUILTIN_TYPES.has(definition.type) && !seen.has(definition.type)) {
      const named = this.registry.get(definition.type);
      if (named) {
        const nextSeen = new Set(seen).add(definition.type);
        // The named type's structure first, then its own rules.
        const { validation: _ownRules, ...structure } = named;
        await this.value(
          { ...structure, type: named.fields ? 'object' : named.type },
          value,
          path,
          parent,
          nextSeen,
        );
        for (const rule of collectRules(named)) {
          await checkRule(rule, value, path, context, this.errors);
        }
        return;
      }
    }

    if (definition.fields && value !== undefined && value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const field of definition.fields) {
        await this.value(
          field,
          record[field.name],
          path ? `${path}.${field.name}` : field.name,
          record,
          seen,
        );
      }
    }

    if (definition.of && Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const member = this.member(definition.of, item);
        if (member) await this.value(member, item, `${path}[${index}]`, value, seen);
      }
    }
  }

  private member(
    members: ArrayMemberDefinition[],
    item: unknown,
  ): ArrayMemberDefinition | undefined {
    if (item !== null && typeof item === 'object') {
      const itemType = (item as Record<string, unknown>)['_type'];
      const byType = members.find((m) => (m.name ?? m.type) === itemType);
      if (byType) return byType;
    }
    return members.length === 1 ? members[0] : undefined;
  }
}

/** Validates one document (its `_type` picks the schema) and returns every error found. */
export async function validateDocument(
  document: Record<string, unknown>,
  schema: readonly TypeDefinition[],
  options: ValidateOptions = {},
): Promise<ValidationError[]> {
  const typeName = document['_type'];
  const type = schema.find((t) => t.name === typeName);
  if (!type) return [{ path: '_type', message: `Unknown document type ${String(typeName)}` }];
  const walker = new Walker(schema, document, options);
  await walker.value({ ...type, type: 'object' }, document, '', undefined);
  return walker.errors;
}
