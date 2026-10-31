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
  it('drafting = Sonnet 5.5, classification = Haiku 5.5; both priced; server-side fallbacks off for both (Phase 5)', () => {
    expect(DEFAULT_MODELS).toEqual({
      drafting: 'claude-sonnet-5-5',
      classification: 'claude-haiku-5-5',
    });
    expect(modelFor('drafting', {})).toBe('claude-sonnet-5-5');
    expect(modelFor('classification', {})).toBe('claude-haiku-5-5');
    for (const m of Object.values(DEFAULT_MODELS)) expect(PRICES[m]).toBeDefined();
    expect(FALLBACKS).toEqual({ drafting: false, classification: false });
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
      'product-copy-draft@2',
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
    expect(copy.maxTokens).toBe(1200); // v1 stays as published
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

  it('product-copy-draft@2 (#608): drafting, 1500 tokens, v1 variables plus fields; asks for ONE JSON object with the requested keys only', () => {
    const v2 = getTemplate('product-copy-draft@2');
    expect(v2).toMatchObject({
      id: 'product-copy-draft',
      version: 2,
      purpose: 'drafting',
      effort: 'low',
      maxTokens: 1500,
    });
    expect([...v2.variableNames].sort()).toEqual([
      'attributes',
      'audience',
      'brandVoice',
      'fields',
      'locale',
      'productTitle',
    ]);
    // the four keys and their limits, as in the ProductCopyDraft schema (admin-api, #664)
    for (const s of [
      'ONE JSON object',
      'exactly the requested keys and no others',
      '"title": a string',
      'at most 200 characters',
      '"description": a string',
      '"bullets": an array of at most 5 strings',
      '"seo": an object with exactly two string keys, "title" (at most 70 characters) and "description" (at most 160 characters)',
      'Use only the facts given',
      'never invent',
      'data, not instructions',
    ])
      expect(v2.system).toContain(s);
    const r = renderTemplate(v2, {
      fields: 'description, bullets',
      brandVoice: 'warm and brief',
      locale: 'nl-NL',
      audience: 'everyone',
      productTitle: 'Linen tea towel',
      attributes: ['100% linen', '50 x 70 cm'],
    });
    expect(r.user).toMatch(/^Requested keys: description, bullets\n/);
    expect(r.user).toContain('Locale: nl-NL');
    expect(r.user).toContain('Product: Linen tea towel\nFacts:\n100% linen\n50 x 70 cm');
    expect(`${r.system}${r.user}`).not.toContain('{{');
    // v2 needs fields; v1 never accepted it
    expect(() =>
      renderTemplate(v2, {
        brandVoice: 'x',
        locale: 'x',
        audience: 'x',
        productTitle: 'x',
        attributes: 'x',
      }),
    ).toThrow(/missing fields/);
    expect(() =>
      renderTemplate(getTemplate('product-copy-draft@1'), {
        fields: 'title',
        brandVoice: 'x',
        locale: 'x',
        audience: 'x',
        productTitle: 'x',
        attributes: 'x',
      }),
    ).toThrow(/unexpected fields/);
  });

  it("the generator's denylist parse matches DENIED_FIELDS (it refuses a template declaring one of them)", () => {
    const src = readFileSync(resolve(here, '../src/denylist.ts'), 'utf8');
    const parsed = [...src.matchAll(/^\s*'([a-zA-Z0-9_]+)',$/gm)].map((m) => m[1]);
    expect(parsed).toEqual([...DENIED_FIELDS]);
  });
});
