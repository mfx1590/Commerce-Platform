// The frozen OpenAPI documents of packages/contracts, loaded at runtime: request bodies are validated against the
// exact `requestBody` schema of each operation (400 `validation_error` with per-path details), and each
// operation's `x-permission` is read from the same source the admin UI and the reviewer read. OpenAPI 3.1 schemas
// are JSON Schema 2020-12, so the whole document is one Ajv schema and components resolve by JSON pointer.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { validationError } from '../lib/errors';
import type { Permission } from './permissions';

export type SpecFile = 'store-api.yaml' | 'admin-api.yaml';

interface Operation {
  operationId?: string;
  'x-permission'?: Permission;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
}
interface OpenApiDoc {
  paths: Record<string, Record<string, Operation>>;
  components?: Record<string, unknown>;
}

/**
 * Where the yaml files live. `CONTRACTS_OPENAPI_DIR` wins; otherwise walk up from this file to the workspace
 * (`packages/contracts/openapi`, both from src/ in dev and from .medusa/server after a build) or to an installed
 * `node_modules/@platform/contracts/openapi`. The package's export map does not expose the yaml files, hence no
 * `require.resolve`.
 */
export function openApiDir(): string {
  if (process.env.CONTRACTS_OPENAPI_DIR) return process.env.CONTRACTS_OPENAPI_DIR;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    for (const candidate of [
      join(dir, 'packages', 'contracts', 'openapi'),
      join(dir, 'node_modules', '@platform', 'contracts', 'openapi'),
    ]) {
      if (existsSync(join(candidate, 'admin-api.yaml'))) return resolve(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('packages/contracts/openapi not found (set CONTRACTS_OPENAPI_DIR)');
}

export interface Spec {
  readonly doc: OpenApiDoc;
  /** `x-permission` of an operation (throws if the operation has none — every admin operation must). */
  permission(operationId: string): Permission;
  /** Validates `body` against the operation's JSON request body; throws 400 `validation_error` with details. */
  validateBody(operationId: string, body: unknown): void;
  /** Compiled validator for `#/components/schemas/<name>` (tests, response checks). */
  schema(name: string): ValidateFunction;
}

const specs = new Map<SpecFile, Spec>();

function details(errors: ErrorObject[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors ?? []) {
    const missing = (e.params as { missingProperty?: string }).missingProperty;
    const path = (e.instancePath || '') + (missing ? `/${missing}` : '');
    const key = path.replace(/^\//, '').replace(/\//g, '.') || 'body';
    const extra =
      (e.params as { additionalProperty?: string }).additionalProperty ??
      (e.params as { allowedValues?: unknown[] }).allowedValues?.join(', ');
    out[key] = `${e.message ?? 'invalid'}${extra ? ` (${extra})` : ''}`;
  }
  return out;
}

/**
 * LOCAL OVERLAYS (#413 / CONTRACT CHANGE #417): a yaml under apps/core/test/fixtures carrying the operations the
 * core already implements ahead of the contract landing. Applied only while the base document's `info.version` is
 * below the overlay's; once main carries that version the file is deleted (same PR as the merge). `paths` and
 * `components.*` are deep-merged (overlay keys added or replaced, everything else kept).
 */
const LOCAL_OVERLAYS: Record<SpecFile, { file: string; version: string }[]> = {
  'admin-api.yaml': [{ file: 'admin-api.0.4.11.overlay.yaml', version: '0.4.11' }],
  'store-api.yaml': [],
};

function overlayDir(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'test', 'fixtures');
    if (existsSync(join(dir, 'package.json')) && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const semverBelow = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
};

function deepMerge(base: unknown, over: unknown): unknown {
  if (
    base !== null &&
    typeof base === 'object' &&
    !Array.isArray(base) &&
    over !== null &&
    typeof over === 'object' &&
    !Array.isArray(over)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>))
      out[k] = deepMerge(out[k], v);
    return out;
  }
  return over;
}

/** The base document with every applicable local overlay merged in (none when the base is current). */
export function withLocalOverlays<T extends object>(doc: T, file: SpecFile): T {
  const dir = overlayDir();
  if (!dir) return doc;
  let out = doc;
  for (const overlay of LOCAL_OVERLAYS[file]) {
    const path = join(dir, overlay.file);
    const version = (out as { info?: { version?: string } }).info?.version ?? '0.0.0';
    if (!existsSync(path) || !semverBelow(version, overlay.version)) continue;
    const extra = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    out = deepMerge(out, extra) as T;
  }
  return out;
}

export function loadSpec(file: SpecFile): Spec {
  const cached = specs.get(file);
  if (cached) return cached;

  const doc = withLocalOverlays(
    parse(readFileSync(join(openApiDir(), file), 'utf8')) as OpenApiDoc,
    file,
  );
  const id = `https://contracts.local/${file}`;
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    coerceTypes: false,
  });
  const applyFormats = ((addFormats as unknown as { default?: unknown }).default ?? addFormats) as (
    a: Ajv2020,
  ) => void;
  applyFormats(ajv);
  ajv.addSchema({ ...doc, $id: id });

  const operations = new Map<string, { path: string; method: string; op: Operation }>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op && typeof op === 'object' && 'operationId' in op && op.operationId) {
        operations.set(op.operationId, { path, method, op });
      }
    }
  }
  const compiled = new Map<string, ValidateFunction>();
  const compile = (key: string, schema: object): ValidateFunction => {
    let fn = compiled.get(key);
    if (!fn) {
      fn = ajv.compile(schema);
      compiled.set(key, fn);
    }
    return fn;
  };
  const operation = (operationId: string) => {
    const found = operations.get(operationId);
    if (!found) throw new Error(`${file}: unknown operationId ${operationId}`);
    return found;
  };

  const spec: Spec = {
    doc,
    permission(operationId) {
      const perm = operation(operationId).op['x-permission'];
      if (!perm) throw new Error(`${file}: ${operationId} has no x-permission`);
      return perm;
    },
    validateBody(operationId, body) {
      const { path, method, op } = operation(operationId);
      const schema = op.requestBody?.content?.['application/json']?.schema;
      if (!schema) return;
      if (body === undefined || body === null || typeof body !== 'object') {
        throw validationError('request body must be a JSON object', { body: 'object' });
      }
      // Reference the schema by JSON pointer INTO the registered document, so its nested `#/components/...`
      // refs resolve against the document rather than against a standalone copy.
      const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
      const pointer = `${id}#/paths/${esc(path)}/${method}/requestBody/content/${esc('application/json')}/schema`;
      const fn = compile(`body:${operationId}`, { $ref: pointer });
      if (!fn(body)) throw validationError('invalid request body', details(fn.errors));
    },
    schema(name) {
      return compile(`schema:${name}`, { $ref: `${id}#/components/schemas/${name}` });
    },
  };
  specs.set(file, spec);
  return spec;
}
