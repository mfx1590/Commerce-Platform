// The Finance read API's contract, read from the OpenAPI file at construction (#551): every operation's path, method
// and `x-permission` come from the yaml, so the permission matrix the server enforces IS the contract's — the same
// pattern as apps/core. The file is the landed packages/contracts/openapi/accounting.yaml (CONTRACT CHANGE #572),
// resolved through the @platform/contracts package (its `openapi/` folder ships with it); `ACCOUNTING_SPEC_PATH`
// overrides it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse } from 'yaml';

export interface ApiOperation {
  operationId: string;
  method: 'get';
  /** `/accounting/v1/legal-entities/{legalEntityId}/payouts/{payoutId}` */
  path: string;
  permission: { relation: string; object: string };
  /** Query parameter names the operation declares (anything else is a 400). */
  queryParams: string[];
}

export interface ApiSpec {
  version: string;
  operations: ApiOperation[];
  /** The parsed document, for response validation in tests. */
  document: Record<string, unknown>;
}

/** packages/contracts/openapi/accounting.yaml, found through the package's main entry (`dist/index.js` → `../openapi/`). */
export function landedSpecPath(): string {
  const entry = createRequire(import.meta.url).resolve('@platform/contracts');
  return path.resolve(path.dirname(entry), '..', 'openapi', 'accounting.yaml');
}

export function defaultSpecPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACCOUNTING_SPEC_PATH ?? landedSpecPath();
}

export const DEFAULT_SPEC_PATH = defaultSpecPath();

interface RawParam {
  name?: string;
  in?: string;
  $ref?: string;
}

export function loadApiSpec(path = DEFAULT_SPEC_PATH): ApiSpec {
  const document = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const info = document.info as { version: string };
  const components = (document.components ?? {}) as { parameters?: Record<string, RawParam> };
  const resolveParam = (p: RawParam): RawParam => {
    if (!p.$ref) return p;
    const name = p.$ref.replace('#/components/parameters/', '');
    const target = components.parameters?.[name];
    if (!target) throw new Error(`spec: unresolved parameter ${p.$ref}`);
    return target;
  };
  const operations: ApiOperation[] = [];
  for (const [path, methods] of Object.entries(
    document.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const [method, raw] of Object.entries(methods)) {
      const op = raw as {
        operationId: string;
        'x-permission'?: { relation: string; object: string };
        parameters?: RawParam[];
      };
      if (method !== 'get')
        throw new Error(`spec: ${op.operationId} is ${method}; this API is read-only`);
      if (!op['x-permission']) throw new Error(`spec: ${op.operationId} has no x-permission`);
      operations.push({
        operationId: op.operationId,
        method: 'get',
        path,
        permission: op['x-permission'],
        queryParams: (op.parameters ?? [])
          .map(resolveParam)
          .filter((p) => p.in === 'query')
          .map((p) => p.name!),
      });
    }
  }
  return { version: info.version, operations, document };
}

export interface RouteMatch {
  operation: ApiOperation;
  params: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The operation a request hits, with its path parameters (uuids), or null. */
export function matchRoute(spec: ApiSpec, method: string, pathname: string): RouteMatch | null {
  if (method.toLowerCase() !== 'get') return null;
  const parts = pathname.replace(/\/+$/, '').split('/');
  for (const operation of spec.operations) {
    const template = operation.path.split('/');
    if (template.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < template.length; i++) {
      const t = template[i]!;
      const v = parts[i]!;
      if (t.startsWith('{') && t.endsWith('}')) {
        if (!UUID.test(v)) {
          ok = false;
          break;
        }
        params[t.slice(1, -1)] = v.toLowerCase();
      } else if (t !== v) {
        ok = false;
        break;
      }
    }
    if (ok) return { operation, params };
  }
  return null;
}
