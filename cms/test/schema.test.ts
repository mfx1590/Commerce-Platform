import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TYPES,
  DOCUMENT_TYPES,
  PRODUCT_HANDLE_PATTERN,
  collectRules,
  imageWithAlt,
  productStory,
  schemaTypes,
} from '../src/index.js';
import type { BaseDefinition, TypeDefinition } from '../src/index.js';

function walk(definition: BaseDefinition, visit: (d: BaseDefinition) => void): void {
  visit(definition);
  for (const field of definition.fields ?? []) walk(field, visit);
  for (const member of definition.of ?? []) walk(member, visit);
  for (const annotation of definition.marks?.annotations ?? []) walk(annotation, visit);
}

describe('schema registry', () => {
  const names = new Set(schemaTypes.map((type) => type.name));

  it('registers every document type the fetch layer knows, with a title', () => {
    for (const type of DOCUMENT_TYPES) {
      const definition = schemaTypes.find((t) => t.name === type);
      expect(definition, type).toBeDefined();
      expect(definition?.type).toBe('document');
      expect(definition?.title).toBeTruthy();
    }
  });

  it('has unique type names', () => {
    expect(names.size).toBe(schemaTypes.length);
  });

  it('references only built-in or registered types', () => {
    const dangling: string[] = [];
    for (const type of schemaTypes) {
      walk(type, (d) => {
        if (!BUILTIN_TYPES.has(d.type) && !names.has(d.type))
          dangling.push(`${type.name} → ${d.type}`);
      });
    }
    expect(dangling).toEqual([]);
  });

  it('requires a locale and a slug on every routed document', () => {
    for (const name of ['page', 'campaignLanding', 'legal']) {
      const type = schemaTypes.find((t) => t.name === name) as TypeDefinition;
      for (const fieldName of ['locale', 'slug', 'title']) {
        const field = type.fields?.find((f) => f.name === fieldName);
        expect(field, `${name}.${fieldName}`).toBeDefined();
        const kinds = collectRules(field!).flatMap((rule) => rule.constraints.map((c) => c.kind));
        expect(kinds, `${name}.${fieldName}`).toContain('required');
      }
    }
  });

  it('never allows an image without alt text', () => {
    const alt = imageWithAlt.fields.find((f) => f.name === 'alt')!;
    const kinds = collectRules(alt).flatMap((rule) => rule.constraints.map((c) => c.kind));
    expect(kinds).toContain('required');
    // and every image anywhere in the schema is this type, not a bare `image`
    const bareImages: string[] = [];
    for (const type of schemaTypes) {
      if (type.name === 'imageWithAlt') continue;
      walk(type, (d) => {
        if (d.type === 'image') bareImages.push(type.name);
      });
    }
    expect(bareImages).toEqual([]);
  });

  it('product stories reference products by kebab-case handle only', () => {
    const handle = productStory.fields.find((f) => f.name === 'productHandle')!;
    const rules = collectRules(handle);
    expect(rules[0]?.constraints.map((c) => c.kind)).toEqual(['required', 'regex']);
    expect(PRODUCT_HANDLE_PATTERN.test('alpine-backpack')).toBe(true);
    expect(PRODUCT_HANDLE_PATTERN.test('Alpine Backpack')).toBe(false);
    expect(PRODUCT_HANDLE_PATTERN.test('/products/alpine-backpack')).toBe(false);
  });

  it('records the rule chain in order, with warning level kept apart', () => {
    const rules = collectRules({
      type: 'string',
      validation: (rule) => [rule.required().max(3), rule.min(1).warning('short')],
    });
    expect(rules).toHaveLength(2);
    expect(rules[0]?.constraints.map((c) => c.kind)).toEqual(['required', 'max']);
    expect(rules[1]?.level).toBe('warning');
    expect(rules[1]?.message).toBe('short');
  });
});
