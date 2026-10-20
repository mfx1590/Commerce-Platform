import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

/**
 * The store the perf gate's Prism mock describes (#447).
 *
 * `scripts/perf.mjs` measures against the Prism Store API mock, whose `GET /store` example is brand A
 * (`code: brand-a`, `locales: ['en-GB', 'de-DE']`). The root layout correctly 404s a locale the store
 * does not offer, so a brand that sells another locale (brand C: `en-US`) could never be warmed or
 * measured — a correct app failing an assumption of the harness.
 *
 * A brand ships `perf/store.example.json` — its own store as the Store API would describe it — and
 * `perf.mjs` starts Prism from a **copy** of the spec whose `GET /store` example is that file. No file,
 * no change: the starter and brand A measure exactly as before. The example is validated against the
 * spec's own `Store` schema first, so a wrong one fails loudly instead of 404-ing quietly.
 */

/** Where an app ships its example, relative to the app root. */
export const STORE_EXAMPLE_PATH = join('perf', 'store.example.json');

/**
 * The app's example, or `null` when it ships none.
 *
 * @param {string} appRoot
 * @returns {Record<string, unknown> | null}
 */
export function readStoreExample(appRoot) {
  const path = join(appRoot, STORE_EXAMPLE_PATH);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`perf: ${STORE_EXAMPLE_PATH.replace(/\\/g, '/')} is not valid JSON.`);
  }
}

/**
 * Throws, listing every problem, when `example` is not a `Store` by the spec's own schema.
 *
 * @param {string} specText the Store API spec (YAML)
 * @param {unknown} example
 */
export function validateStoreExample(specText, example) {
  const spec = parse(specText);
  // OpenAPI 3.1 schemas are JSON Schema 2020-12; the spec carries OpenAPI's own keywords
  // (`example`, `x-*`), so not strict.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(spec, 'store-api');
  const validate = ajv.compile({ $ref: 'store-api#/components/schemas/Store' });
  if (validate(example)) return;
  const problems = (validate.errors ?? [])
    .map((error) => `${error.instancePath || '(root)'} ${error.message}`)
    .join('; ');
  throw new Error(
    `perf: ${STORE_EXAMPLE_PATH.replace(/\\/g, '/')} does not match the Store schema: ${problems}`,
  );
}

const STORE_EXAMPLE_LINE = /^(\s*)brandA: \{ \$ref: '#\/components\/examples\/StoreBrandA' \}$/;

/**
 * The spec text with `GET /store`'s 200 example replaced by `example` — **one line** changes. JSON is
 * valid YAML flow syntax, so the example goes in as `brandA: { value: <json> }` on that line. Fails if
 * the spec no longer has exactly that one line, rather than guessing.
 *
 * @param {string} specText
 * @param {Record<string, unknown>} example
 * @returns {string}
 */
export function overlayStoreExample(specText, example) {
  const lines = specText.split('\n');
  const start = lines.findIndex((line) => /^\s*operationId: getStore\s*$/.test(line));
  const next = lines.findIndex((line, i) => i > start && /^\s*operationId: /.test(line));
  const end = next === -1 ? lines.length : next;
  const matches = [];
  for (let i = start; start !== -1 && i < end; i += 1) {
    if (STORE_EXAMPLE_LINE.test(lines[i])) matches.push(i);
  }
  if (matches.length !== 1) {
    throw new Error(
      `perf: expected exactly one StoreBrandA example under getStore in the Store API spec, found ${matches.length}`,
    );
  }
  const at = matches[0];
  const indent = STORE_EXAMPLE_LINE.exec(lines[at])[1];
  lines[at] = `${indent}brandA: { value: ${JSON.stringify(example)} }`;
  return lines.join('\n');
}
