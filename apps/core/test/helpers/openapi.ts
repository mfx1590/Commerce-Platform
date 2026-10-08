// Response validation against the frozen OpenAPI documents in packages/contracts (issue #6). OpenAPI 3.1 schemas
// are JSON Schema 2020-12, so the whole document is registered as one schema and components are addressed by
// JSON pointer ($ref '#/components/schemas/X' resolves inside it).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

function loadSpec(file: 'store-api.yaml' | 'admin-api.yaml'): Record<string, unknown> {
  // @platform/contracts does not export package.json (export map), so resolve the workspace path directly.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  return parse(
    readFileSync(join(root, 'packages', 'contracts', 'openapi', file), 'utf8'),
  ) as Record<string, unknown>;
}

export interface SpecValidator {
  /** Throws with the Ajv errors when `body` does not match `#/components/schemas/<name>`. */
  assertSchema(name: string, body: unknown): void;
  /** Throws when `body` is not a `Page` whose `items` all match `#/components/schemas/<itemName>`. */
  assertPage(itemName: string, body: unknown): void;
  /** Throws when `body` is not `{ items: <itemName>[] }`. */
  assertItems(itemName: string, body: unknown): void;
}

export function specValidator(file: 'store-api.yaml' | 'admin-api.yaml'): SpecValidator {
  const doc = loadSpec(file);
  const id = `https://contracts.local/${file}`;
  const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  const applyFormats = ((addFormats as unknown as { default?: unknown }).default ?? addFormats) as (
    a: Ajv2020,
  ) => void;
  applyFormats(ajv);
  ajv.addSchema({ ...doc, $id: id });
  const cache = new Map<string, ValidateFunction>();
  const compile = (schema: object, key: string): ValidateFunction => {
    let fn = cache.get(key);
    if (!fn) {
      fn = ajv.compile(schema);
      cache.set(key, fn);
    }
    return fn;
  };
  const ref = (name: string) => ({ $ref: `${id}#/components/schemas/${name}` });
  const run = (fn: ValidateFunction, body: unknown, what: string) => {
    if (!fn(body)) {
      const errors = (fn.errors ?? [])
        .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
        .join('; ');
      throw new Error(
        `${what} does not match the contract: ${errors}\n${JSON.stringify(body).slice(0, 600)}`,
      );
    }
  };
  return {
    assertSchema: (name, body) => run(compile(ref(name), `schema:${name}`), body, name),
    assertPage: (itemName, body) =>
      run(
        compile(
          {
            allOf: [
              ref('Page'),
              {
                type: 'object',
                required: ['items'],
                properties: { items: { type: 'array', items: ref(itemName) } },
              },
            ],
          },
          `page:${itemName}`,
        ),
        body,
        `Page<${itemName}>`,
      ),
    assertItems: (itemName, body) =>
      run(
        compile(
          {
            type: 'object',
            required: ['items'],
            properties: { items: { type: 'array', items: ref(itemName) } },
          },
          `items:${itemName}`,
        ),
        body,
        `{ items: ${itemName}[] }`,
      ),
  };
}
