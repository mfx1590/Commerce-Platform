import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  overlayStoreExample,
  readStoreExample,
  STORE_EXAMPLE_PATH,
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

/** Brand A's own example, re-dressed as a one-locale US brand. */
function brandC(): Record<string, unknown> {
  const spec = parse(SPEC) as Spec;
  return {
    ...spec.components.examples.StoreBrandA!.value,
    code: 'brand-c',
    name: 'Brand C',
    default_currency: 'USD',
    default_locale: 'en-US',
    default_country: 'US',
    currencies: ['USD'],
    locales: ['en-US'],
  };
}

/** The 200 example `GET /store` answers with in a spec (after Prism-style $ref resolution). */
function storeExampleIn(specText: string): unknown {
  const spec = parse(specText) as Spec;
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

describe('overlayStoreExample', () => {
  it('makes GET /store answer the brand’s example, and changes nothing else', () => {
    const example = brandC();
    const overlaid = overlayStoreExample(SPEC, example);

    expect(storeExampleIn(SPEC)).toMatchObject({ code: 'brand-a' });
    expect(storeExampleIn(overlaid)).toEqual(example);

    const before = SPEC.split('\n');
    const after = overlaid.split('\n');
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, i) => line !== before[i])).toHaveLength(1);
  });
});
