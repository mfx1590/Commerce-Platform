// Structural guards (also enforced by eslint.config.mjs for the pg rule): nothing but src/lib/db.ts touches pg,
// and nothing but src/outbox writes to the outbox table (ADR 0003, task 1.5).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const files = walk(SRC).map((p) => ({
  rel: relative(SRC, p).replace(/\\/g, '/'),
  text: readFileSync(p, 'utf8'),
}));

describe('structural guards', () => {
  it('only src/lib/db.ts imports pg', () => {
    const offenders = files
      .filter((f) => f.rel !== 'lib/db.ts')
      .filter((f) => /from\s+['"]pg(\/|['"])|require\(\s*['"]pg['"]\s*\)/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('only src/outbox writes to the outbox table', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('outbox/'))
      .filter((f) => /insert\s+into\s+"?outbox"?/i.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('only src/modules/orders updates the "order" row (state machine, task 2.3)', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('modules/orders/') && !f.rel.endsWith('.test.ts'))
      .filter((f) => /update\s+"order"/i.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('only src/modules/inventory changes on_hand or appends stock movements (task 2.4)', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('modules/inventory/') && !f.rel.endsWith('.test.ts'))
      .filter((f) => /update\s+inventory_level|insert\s+into\s+stock_movement/i.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('no checkout ↔ orders cycle: src/modules/orders never imports the checkout module (task 2.5)', () => {
    const offenders = files
      .filter((f) => f.rel.startsWith('modules/orders/') && !f.rel.endsWith('.test.ts'))
      .filter((f) => /from\s+['"]\.\.\/checkout['"]/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the cart never imports the promotions module: prices arrive through the PriceResolver seam (src/wiring.ts, #179 part 3)', () => {
    const offenders = files
      .filter((f) => f.rel.startsWith('modules/cart/') || f.rel.startsWith('modules/checkout/'))
      // `from '../promotions'`, a deep path (`../promotions/pricing`), a longer way round
      // (`../../modules/promotions`), `import('…')` and `require('…')` — all of them
      .filter((f) =>
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/promotions(?:\/[^'"]*)?['"]/.test(
          f.text,
        ),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the promotions-import pattern catches deep, roundabout, dynamic and require forms', () => {
    const pattern =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/promotions(?:\/[^'"]*)?['"]/;
    for (const line of [
      "import { resolvePrices } from '../promotions';",
      "import { resolvePrices } from '../promotions/pricing';",
      "import { resolvePrices } from '../../modules/promotions';",
      "const m = await import('../promotions');",
      "const m = require('../promotions/index');",
    ]) {
      expect(pattern.test(line)).toBe(true);
    }
    for (const line of [
      "import { x } from '../cart';",
      '// see the promotions module README',
      "import { y } from './promotion-codes';",
    ]) {
      expect(pattern.test(line)).toBe(false);
    }
  });

  it('modules import the outbox helper through its index only', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('outbox/'))
      .filter((f) => /from\s+['"][./]*outbox\/with-events['"]/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('ADR 0005: a module is imported only through its index.ts from outside the module', () => {
    // Resolve every relative import to a path under src/ and flag imports that land inside
    // src/modules/<m>/<file> from a file that is not itself part of src/modules/<m>/.
    const offenders: string[] = [];
    for (const f of files) {
      const fromDir = join(SRC, f.rel, '..');
      const ownModule = /^modules\/([^/]+)\//.exec(f.rel)?.[1];
      for (const m of f.text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = relative(SRC, join(fromDir, m[1]!)).replace(/\\/g, '/');
        const hit = /^modules\/([^/]+)\/(.+)$/.exec(target);
        if (!hit) continue;
        const [, moduleName, inner] = hit;
        if (moduleName === ownModule) continue;
        if (inner === 'index' || inner === 'index.ts') continue;
        offenders.push(`${f.rel} → ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
