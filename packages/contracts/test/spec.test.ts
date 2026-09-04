// Static checks on the OpenAPI documents (text-level, dependency-free). Runtime checks live in contract.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELATIONS } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(here, '../openapi', f), 'utf8');

/** Splits a spec into operation blocks: from one `operationId:` line to the next. */
function operations(text: string): Array<{ id: string; body: string }> {
  const lines = text.split('\n');
  const out: Array<{ id: string; body: string }> = [];
  let current: { id: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^\s+operationId:\s*(\w+)/);
    if (m) {
      if (current) out.push({ id: current.id, body: current.body.join('\n') });
      current = { id: m[1]!, body: [] };
      continue;
    }
    if (/^\s{2}\/|^components:/.test(line) && current) {
      out.push({ id: current.id, body: current.body.join('\n') });
      current = null;
    }
    current?.body.push(line);
  }
  if (current) out.push({ id: current.id, body: current.body.join('\n') });
  return out;
}

describe('store-api.yaml', () => {
  const text = read('store-api.yaml');
  const ops = operations(text);

  it('is OpenAPI 3.1 and covers the storefront journey', () => {
    expect(text.startsWith('openapi: 3.1.0')).toBe(true);
    const ids = ops.map((o) => o.id);
    for (const id of [
      'getStore',
      'listProducts',
      'getProduct',
      'createCart',
      'addLineItem',
      'listShippingOptions',
      'createPaymentSession',
      'completeCart',
      'getOrder',
      'getMe',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every operation declares tags and at least one response with a schema', () => {
    // `tags:` precedes `operationId:` in our layout, so count them per document.
    expect((text.match(/^ {6}tags: \[/gm) ?? []).length).toBe(ops.length);
    for (const o of ops) {
      expect(o.body, o.id).toMatch(/responses:/);
      expect(o.body, o.id).toMatch(/schema:/);
    }
  });

  it('requires the publishable key and never accepts card data', () => {
    expect(text).toMatch(/X-Publishable-Key/);
    expect(text).not.toMatch(/card_number|cvc|pan\b/i);
  });
});

describe('admin-api.yaml', () => {
  const text = read('admin-api.yaml');
  const ops = operations(text);

  it('covers the nine areas from the Phase 0 brief', () => {
    for (const tag of [
      'registry',
      'catalog',
      'pricing',
      'orders',
      'inventory',
      'fulfillment',
      'customers',
      'roles',
      'audit',
    ]) {
      expect(text, tag).toMatch(new RegExp(`tags: \\[[^\\]]*\\b${tag}\\b`));
    }
    expect(ops.length).toBeGreaterThanOrEqual(45);
  });

  it('every operation except getMe declares x-permission with a known relation', () => {
    for (const o of ops) {
      if (o.id === 'getMe') continue;
      const m = o.body.match(/x-permission:\s*\{\s*relation:\s*(\w+),\s*object:\s*'([^']+)'/);
      expect(m, `${o.id} lacks x-permission`).not.toBeNull();
      const relation = m![1]!;
      expect([...RELATIONS, 'viewer'], `${o.id}: ${relation}`).toContain(relation);
      expect(m![2], o.id).toMatch(
        /^(organization:hq|store:\{storeId\}|store:\{store_id\}|store:\*)$/,
      );
    }
  });

  it('finance-only surfaces are gated on organization:hq (a store admin can never satisfy them)', () => {
    const le = ops.find((o) => o.id === 'listLegalEntities')!;
    expect(le.body).toMatch(/relation: finance, object: 'organization:hq'/);
  });

  it('money is always { amount_minor, currency }, never a float', () => {
    expect(text).not.toMatch(/type: number/);
    expect(text).toMatch(/amount_minor: \{ type: integer/);
  });
});
