import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AiConfigError,
  costMicroUsd,
  DEFAULT_MODELS,
  DENIED_FIELDS,
  FALLBACKS,
  getTemplate,
  modelFor,
  PRICES,
  renderTemplate,
  TEMPLATES,
  TemplateError,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('model registry', () => {
  it('drafting = Sonnet 5.5, classification = Haiku 5.5; both priced; fallbacks only for drafting', () => {
    expect(DEFAULT_MODELS).toEqual({
      drafting: 'claude-sonnet-5-5',
      classification: 'claude-haiku-5-5',
    });
    expect(modelFor('drafting', {})).toBe('claude-sonnet-5-5');
    expect(modelFor('classification', {})).toBe('claude-haiku-5-5');
    for (const m of Object.values(DEFAULT_MODELS)) expect(PRICES[m]).toBeDefined();
    expect(FALLBACKS).toEqual({ drafting: true, classification: false });
  });

  it('env overrides, but only to a priced model', () => {
    expect(modelFor('drafting', { AI_MODEL_DRAFTING: 'claude-opus-5-5' })).toBe('claude-opus-5-5');
    expect(modelFor('classification', { AI_MODEL_CLASSIFICATION: ' ' })).toBe('claude-haiku-5-5');
    expect(() => modelFor('drafting', { AI_MODEL_DRAFTING: 'some-unpriced-model' })).toThrow(
      AiConfigError,
    );
  });

  it('cost is integer micro-USD, rounded up, priced by the served model (or the requested one if unknown)', () => {
    // Sonnet 5.5: 1000 in × 2000 n$ + 500 out × 10000 n$ = 7,000,000 n$ = 7000 µ$
    expect(
      costMicroUsd('claude-sonnet-5-5', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
      }),
    ).toBe(7000);
    // Haiku 5.5: 3 in × 100 n$ + 1 out × 500 n$ = 800 n$ → 1 µ$ (rounded up)
    expect(
      costMicroUsd('claude-haiku-5-5', { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0 }),
    ).toBe(1);
    expect(
      costMicroUsd('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000 }),
    ).toBe(200);
    expect(
      costMicroUsd(
        'unknown-served-model',
        { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 },
        'claude-sonnet-5-5',
      ),
    ).toBe(2000);
    expect(costMicroUsd('unknown', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 })).toBe(
      0,
    );
  });
});

describe('templates', () => {
  it('every template is id@version with a purpose, an effort, a token cap and its declared variables', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([
      'product-category-suggest@1',
      'product-copy-draft@1',
    ]);
    const copy = getTemplate('product-copy-draft@1');
    expect(copy).toMatchObject({
      id: 'product-copy-draft',
      version: 1,
      purpose: 'drafting',
      effort: 'low',
    });
    expect([...copy.variableNames].sort()).toEqual([
      'attributes',
      'audience',
      'brandVoice',
      'locale',
      'productTitle',
    ]);
    expect(getTemplate('product-category-suggest@1').purpose).toBe('classification');
    expect(() => getTemplate('nope@1')).toThrow(TemplateError);
  });

  it('renders placeholders; lists one per line; exactly the declared variables', () => {
    const t = getTemplate('product-category-suggest@1');
    const r = renderTemplate(t, {
      productTitle: 'Linen shirt',
      attributes: ['linen', 'size M'],
      categories: ['shirts', 'tops'],
    });
    expect(r.user).toContain('Categories:\nshirts\ntops');
    expect(r.user).toContain('Product: Linen shirt\nFacts:\nlinen\nsize M');
    expect(r.system).not.toContain('{{');
    expect(() => renderTemplate(t, { productTitle: 'x', attributes: 'y' })).toThrow(
      /missing categories/,
    );
    expect(() =>
      renderTemplate(t, { productTitle: 'x', attributes: 'y', categories: 'z', extra: 'w' }),
    ).toThrow(/unexpected extra/);
    expect(() =>
      renderTemplate(t, {
        productTitle: 'x',
        attributes: 'y',
        categories: { nested: true } as never,
      }),
    ).toThrow(/must be text, a number or a list of strings/);
  });

  it("the generator's denylist parse matches DENIED_FIELDS (it refuses a template declaring one of them)", () => {
    const src = readFileSync(resolve(here, '../src/denylist.ts'), 'utf8');
    const parsed = [...src.matchAll(/^\s*'([a-zA-Z0-9_]+)',$/gm)].map((m) => m[1]);
    expect(parsed).toEqual([...DENIED_FIELDS]);
  });
});
