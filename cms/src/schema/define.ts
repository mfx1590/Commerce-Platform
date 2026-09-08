/**
 * A structural mirror of the subset of Sanity's schema-definition types that this package uses.
 *
 * Why not import them from `sanity`? The Studio package is a devDependency reserved for
 * `sanity.config.ts` (checked by `tsconfig.studio.json`). The schemas, fixtures and validator are
 * plain data and must compile and run without it — the storefront's fetch layer imports the built
 * `dist/` from `@platform/cms`, and neither the storefront nor CI wants the whole Studio for that.
 *
 * Every definition produced with `defineType` / `defineField` is at the same time a valid Sanity
 * schema object: `sanity.config.ts` passes `schemaTypes` straight into `defineConfig`, and the
 * Studio typecheck proves the shapes still line up with the real package.
 */

export interface ValidationClient {
  fetch<T = unknown>(query: string, params?: Record<string, unknown>): Promise<T>;
}

export interface ValidationContext {
  document?: Record<string, unknown> | undefined;
  parent?: unknown;
  path?: readonly (string | number | Record<string, string>)[] | undefined;
  getClient?: ((options: { apiVersion: string }) => ValidationClient) | undefined;
}

export type CustomValidatorResult = true | string | { message: string };

export type CustomValidator = (
  value: unknown,
  context: ValidationContext,
) => CustomValidatorResult | Promise<CustomValidatorResult>;

/** The chainable rule builder Sanity hands to a `validation` callback. */
export interface Rule {
  required(): this;
  min(value: number): this;
  max(value: number): this;
  regex(pattern: RegExp, options?: { name?: string; invert?: boolean }): this;
  uri(options?: { scheme?: (string | RegExp)[]; allowRelative?: boolean }): this;
  unique(): this;
  custom(validator: CustomValidator): this;
  error(message?: string): this;
  warning(message?: string): this;
}

/**
 * Generic on purpose: a callback written against this signature is assignable both to Sanity's
 * `(rule: SanityRule) => SanityRule` and to the recording rule in `src/validate.ts`.
 */
export type ValidationBuilder = <R extends Rule>(rule: R) => R | R[];

export type SchemaTypeName =
  | 'document'
  | 'object'
  | 'array'
  | 'block'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'image'
  | 'number'
  | 'reference'
  | 'slug'
  | 'string'
  | 'text'
  | 'url'
  | (string & {});

export interface PreviewConfig {
  select: Record<string, string>;
  prepare?: (selection: Record<string, unknown>) => {
    title?: string | undefined;
    subtitle?: string | undefined;
    media?: unknown;
  };
}

export interface FieldGroup {
  name: string;
  title: string;
  default?: boolean;
}

export interface BaseDefinition {
  type: SchemaTypeName;
  title?: string;
  description?: string;
  validation?: ValidationBuilder;
  hidden?: boolean;
  readOnly?: boolean;
  initialValue?: unknown;
  group?: string;
  options?: Record<string, unknown>;
  /** `object`, `image` and `document` members */
  fields?: FieldDefinition[];
  /** `array` members */
  of?: ArrayMemberDefinition[];
  /** `reference` targets */
  to?: { type: string }[];
  /** `text` rows */
  rows?: number;
  preview?: PreviewConfig;
  groups?: FieldGroup[];
  /** portable text `block` members */
  styles?: { title: string; value: string }[];
  lists?: { title: string; value: string }[];
  marks?: {
    decorators?: { title: string; value: string }[];
    annotations?: ArrayMemberDefinition[];
  };
}

export interface FieldDefinition extends BaseDefinition {
  name: string;
}

export interface ArrayMemberDefinition extends BaseDefinition {
  name?: string;
}

export interface TypeDefinition extends BaseDefinition {
  name: string;
  title: string;
}

export function defineType<const T extends TypeDefinition>(definition: T): T {
  return definition;
}

export function defineField<const T extends FieldDefinition>(definition: T): T {
  return definition;
}

export function defineArrayMember<const T extends ArrayMemberDefinition>(definition: T): T {
  return definition;
}

/** Sanity's built-in type names; anything else in a `type` must be a name in the schema registry. */
export const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'document',
  'object',
  'array',
  'block',
  'boolean',
  'date',
  'datetime',
  'image',
  'number',
  'reference',
  'slug',
  'string',
  'text',
  'url',
  'span',
]);
