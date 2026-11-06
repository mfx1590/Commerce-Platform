import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  overlayStoreExample,
  readStoreExample,
  STORE_EXAMPLE_PATH,
  storeValidator,
  validateStoreExample,
} from '../scripts/perf-store-example.mjs';

/**
 * #447: the perf gate measures a brand against the Prism mock, whose `GET /store` example is brand A
 * (`en-GB`, `de-DE`), so brand C's `/en-US` routes all 404 and can never be warmed. A brand ships
 * `perf/store.example.json`; `perf.mjs` starts Prism from a copy of the spec carrying it.
 */

const SPEC_PATH = join(
  process.cwd(),
  'node_modules',
  '@platform',
  'contracts',
  'openapi',
  'store-api.yaml',
);
const SPEC = readFileSync(SPEC_PATH, 'utf8');

type Spec = {
  paths: Record<
    string,
    Record<string, { operationId?: string; responses: Record<string, unknown> }>
  >;
  components: { examples: Record<string, { value: Record<string, unknown> }> };
};

/**
 * #620: the spec is parsed ONCE and the Store validator built ONCE, here at collection time, which
 * has no per-test timeout. Both are CPU-bound (a 2 000-line YAML, an Ajv over the whole spec): one
 * test used to parse the spec four times and build two validators, about 0.3 s on a quiet laptop,
 * 1.8 s inside the full suite and over 5 s on a loaded CI runner — Vitest's default timeout. The
 * tests below now only validate, and `storeValidator` caching is itself asserted. The overlay test's
 * YAML parse of the overlaid spec is done here for the same reason (it measured up to 1.7 s).
 */
const PARSED = parse(SPEC) as Spec;
storeValidator(SPEC);

/** Brand A's own example, re-dressed as a one-locale US brand. */
function brandC(): Record<string, unknown> {
  return {
    ...structuredClone(PARSED.components.examples.StoreBrandA!.value),
    code: 'brand-c',
    name: 'Brand C',
    default_currency: 'USD',
    default_locale: 'en-US',
    default_country: 'US',
    currencies: ['USD'],
    locales: ['en-US'],
  };
}

const OVERLAY_EXAMPLE = brandC();
const OVERLAID = overlayStoreExample(SPEC, OVERLAY_EXAMPLE);
const PARSED_OVERLAID = parse(OVERLAID) as Spec;

/** The 200 example `GET /store` answers with in a spec (after Prism-style $ref resolution). */
function storeExampleIn(spec: Spec): unknown {
  const content = (
    spec.paths['/store']!.get!.responses['200'] as {
      content: {
        'application/json': { examples: Record<string, { value?: unknown; $ref?: string }> };
      };
    }
  ).content['application/json'];
  const [first] = Object.values(content.examples);
  if (first?.$ref) return spec.components.examples[first.$ref.split('/').pop()!]!.value;
  return first?.value;
}

describe('readStoreExample', () => {
  it('is null when the app ships no perf/store.example.json — today’s behaviour', () => {
    const app = mkdtempSync(join(tmpdir(), 'perf-app-'));
    expect(readStoreExample(app)).toBeNull();
  });

  it('reads the app’s example, and names a file that is not JSON', () => {
    const app = mkdtempSync(join(tmpdir(), 'perf-app-'));
    mkdirSync(join(app, 'perf'));
    writeFileSync(join(app, STORE_EXAMPLE_PATH), JSON.stringify(brandC()));
    expect(readStoreExample(app)).toMatchObject({ code: 'brand-c' });

    writeFileSync(join(app, STORE_EXAMPLE_PATH), '{not json');
    expect(() => readStoreExample(app)).toThrow(/perf\/store\.example\.json is not valid JSON/);
  });
});

describe('validateStoreExample', () => {
  it('accepts a Store the spec’s schema accepts', () => {
    expect(() => validateStoreExample(SPEC, brandC())).not.toThrow();
  });

  it('refuses a wrong example loudly, naming what is wrong', () => {
    const { code: _code, ...noCode } = brandC();
    expect(() => validateStoreExample(SPEC, noCode)).toThrow(
      /does not match the Store schema.*code/s,
    );
    expect(() => validateStoreExample(SPEC, { ...brandC(), locales: 'en-US' })).toThrow(/locales/);
  });
});

/**
 * A second, tiny spec (JSON is valid YAML) whose Store wants an integer `code`: built here, at
 * collection time, for the same reason as the real one — an Ajv build measured up to 0.9 s in the
 * full suite.
 */
const TINY_SPEC = JSON.stringify({
  components: { schemas: { Store: { properties: { code: { type: 'integer' } } } } },
});
const TINY_VALIDATOR = storeValidator(TINY_SPEC);

describe('storeValidator', () => {
  it('builds the validator once per spec text, so repeated validation is cheap', () => {
    expect(storeValidator(SPEC)).toBe(storeValidator(SPEC));
    expect(storeValidator(TINY_SPEC)).toBe(TINY_VALIDATOR);
  });

  it('a different spec text gets its own validator, never a stale one', () => {
    expect(TINY_VALIDATOR).not.toBe(storeValidator(SPEC));
    expect(storeValidator(TINY_SPEC)({ code: 1 })).toBe(true);
    expect(storeValidator(SPEC)({ code: 1 })).toBe(false);
  });
});

describe('overlayStoreExample', () => {
  it('makes GET /store answer the brand’s example, and changes nothing else', () => {
    expect(storeExampleIn(PARSED)).toMatchObject({ code: 'brand-a' });
    expect(storeExampleIn(PARSED_OVERLAID)).toEqual(OVERLAY_EXAMPLE);

    const before = SPEC.split('\n');
    const after = OVERLAID.split('\n');
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, i) => line !== before[i])).toHaveLength(1);
  });
});
