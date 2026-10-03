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
      // (`../../modules/promotions`), `import('…')`, `require('…')` and a bare side-effect
      // `import '../promotions/x'` — all of them
      .filter((f) =>
        /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/promotions(?:\/[^'"]*)?['"]/.test(
          f.text,
        ),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('checkout and orders never import the fraud module: it registers through src/lib/fraud-seam.ts (#231)', () => {
    const offenders = files
      .filter((f) => f.rel.startsWith('modules/checkout/') || f.rel.startsWith('modules/orders/'))
      .filter((f) => !f.rel.endsWith('.test.ts'))
      .filter((f) =>
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/modules\/fraud(?:\/[^'"]*)?['"]|from\s+['"]\.\.\/fraud(?:\/[^'"]*)?['"]/.test(
          f.text,
        ),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the promotions-import pattern catches deep, roundabout, dynamic, require and bare side-effect forms', () => {
    const pattern =
      /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/promotions(?:\/[^'"]*)?['"]/;
    for (const line of [
      "import { resolvePrices } from '../promotions';",
      "import { resolvePrices } from '../promotions/pricing';",
      "import { resolvePrices } from '../../modules/promotions';",
      "const m = await import('../promotions');",
      "const m = require('../promotions/index');",
      "import '../promotions/register';",
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

  it('createServer() mounts the terminal /admin 404 after our chain and before Medusa loads (#265)', () => {
    const server = files.find((f) => f.rel === 'server.ts')!.text;
    const body = server.slice(server.indexOf('export async function createServer'));
    const chain = body.indexOf('mountCoreMiddleware(app');
    const terminal = body.indexOf("app.use('/admin', adminNotFound)");
    const medusa = body.indexOf('await loaders(');
    expect(chain).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(chain);
    expect(medusa).toBeGreaterThan(terminal);
  });

  it('the customer token verifier seam is code-only: no environment switch, and createServer() never passes one (#303)', () => {
    const server = files.find((f) => f.rel === 'server.ts')!.text;
    const boot = server.slice(server.indexOf('export async function createServer'));
    expect(boot).not.toContain('customerTokenVerifier');
    // CreateServerOptions has no such field either: nothing a deployment configures can reach the seam
    const options = server.slice(
      server.indexOf('export interface CreateServerOptions'),
      server.indexOf('export interface CoreMiddlewareOptions'),
    );
    expect(options).not.toContain('ustomerTokenVerifier');
    const seam = files.find((f) => f.rel === 'http/customer-routes.ts')!.text;
    const resolver = seam.slice(
      seam.indexOf('export function customerTokenVerifierFor'),
      seam.indexOf('export function identityOf'),
    );
    // the only thing it reads from the environment is NODE_ENV — to refuse
    expect(resolver.match(/process\.env\.(\w+)/g)).toEqual(['process.env.NODE_ENV']);
    expect(seam.replace(resolver, '')).not.toContain('process.env');
  });

  it('no non-test code hands a customer token verifier to a route factory, except the chain itself (#318 review)', () => {
    // Every CALL of the three functions that accept a verifier, in non-test source. The list is exact: a new
    // caller — or a new argument at an existing one — fails here and has to be justified in review.
    const calls: string[] = [];
    for (const f of files.filter((x) => !x.rel.endsWith('.test.ts'))) {
      for (const m of f.text.matchAll(
        /(?<!function )\b(mountStoreRoutes|mountCustomerRoutes|getOrderRouteWith|customerGateWith)\(([^()]*)\)/g,
      )) {
        calls.push(`${f.rel}: ${m[1]}(${m[2]!.replace(/\s+/g, ' ').trim()})`);
      }
    }
    expect(calls.sort()).toEqual([
      // `…()` = the default verifier; inside mountStoreRoutes `customerVerifier` is
      // customerTokenVerifierFor(…)'s result
      'http/store-routes.ts: customerGateWith(customerVerifier)',
      'http/store-routes.ts: getOrderRouteWith()',
      'http/store-routes.ts: getOrderRouteWith(customerVerifier)',
      'http/store-routes.ts: mountCustomerRoutes(app, customerVerifier)',
      // inside mountCoreMiddleware: `customerTokenVerifier` is customerTokenVerifierFor(opts.…)'s result
      'server.ts: mountStoreRoutes(app, customerTokenVerifier)',
    ]);
    // the factories are not part of the HTTP layer's public index
    const index = files.find((f) => f.rel === 'http/index.ts')!.text;
    const exported = index.replace(/^\s*\/\/.*$/gm, '');
    for (const name of [
      'mountCustomerRoutes',
      'getOrderRouteWith',
      'customerGateWith',
      'optionalCustomerId',
      'requireCustomer',
    ]) {
      expect(exported).not.toContain(name);
    }
    // and each of them resolves its verifier through the production-refusing function
    const seam = files.find((f) => f.rel === 'http/customer-routes.ts')!.text;
    const storeRoutes = files.find((f) => f.rel === 'http/store-routes.ts')!.text;
    expect(seam).toMatch(
      /export function mountCustomerRoutes\([^)]*\): void \{\s*const verifier = customerTokenVerifierFor\(override\);/,
    );
    expect(storeRoutes).toMatch(
      /export const getOrderRouteWith = \([^)]*\): RequestHandler => \{\s*(?:\/\/[^\n]*\s*)*const verifier = customerTokenVerifierFor\(override\);/,
    );
  });

  it('no Promise.all / allSettled / race over queries of ONE transaction client (tx.query): a connection runs one statement at a time', () => {
    // The argument of every Promise.all(…) / allSettled(…) / race(…) in non-test source, parentheses balanced.
    const offenders: string[] = [];
    for (const f of files.filter((x) => !x.rel.endsWith('.test.ts'))) {
      for (const m of f.text.matchAll(/Promise\.(?:all|allSettled|race)\(/g)) {
        let depth = 1;
        const start = (m.index ?? 0) + m[0].length;
        let i = start;
        for (; i < f.text.length && depth > 0; i += 1) {
          if (f.text[i] === '(') depth += 1;
          else if (f.text[i] === ')') depth -= 1;
        }
        const argument = f.text.slice(start, i);
        if (/\btx\.query\b/.test(argument)) {
          offenders.push(`${f.rel}:${f.text.slice(0, start).split('\n').length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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
