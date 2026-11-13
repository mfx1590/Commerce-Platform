// Contract coverage (#858): every operation of admin-api.yaml and store-api.yaml has a route the core actually
// mounts — or is in ALLOWLIST with the issue that will serve it (or drop it from the contract). Fails both ways: an
// operation without a route that is not allowlisted, and an allowlisted operation that IS served (the list only
// shrinks). It also reports what the core serves under /admin or /store that is NOT in the contract.
//
// "Mounted" is read from the app itself, not grepped: mountCoreMiddleware() composes a bare Express app exactly as
// createServer() does (the same module Admin, Store and webhook routers), and the test walks Express's router stack
// (nested routers included). hq-rbac (window 2) is framework-neutral — one middleware that answers its own route
// table — so its routes are read from that table (HQ_RBAC_ROUTES, plus FINANCE_PING_ROUTE outside production,
// exactly the rule createHqRbac applies). No database, no network: it runs in the unit job.
import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  DevTokenVerifier,
  loadSpec,
  moduleAdminRouters,
  moduleStoreRouters,
  moduleWebhookRouters,
} from '../src/http';
import { FINANCE_PING_ROUTE, HQ_RBAC_ROUTES } from '../src/modules/hq-rbac';
import { inMemoryStoreRegistrar } from '../src/modules/registry';
import { mountCoreMiddleware } from '../src/server';

/**
 * Operations the contract has and the core does not serve yet, each with the issue that serves it (or removes it
 * from the contract). An entry that becomes served makes this test fail: delete it in the same PR.
 */
const ALLOWLIST: Readonly<Record<string, number>> = {
  // #855 — order line-item edits (window 1; PR #863)
  updateOrderLineItem: 855,
  cancelOrderLineItem: 855,
  // #856 — HQ › Marketing dashboard
  getMarketingDashboard: 856,
  // #857 — referrals and reviews (Admin 8 + Store 1)
  listReferralPrograms: 857,
  createReferralProgram: 857,
  getReferralProgram: 857,
  updateReferralProgram: 857,
  deleteReferralProgram: 857,
  listReferrals: 857,
  listReviews: 857,
  moderateReview: 857,
  listProductReviews: 857,
};

/**
 * Routes the core serves under /admin or /store that the contract does not have, each with why. Anything else
 * there fails the test.
 */
const NOT_IN_CONTRACT: Readonly<Record<string, string>> = {
  // hq-rbac's test double (#346 witness): absent in production (HQ_RBAC_ROUTES excludes it; asserted below)
  'GET /admin/finance/ping': 'hq-rbac test double, not mounted in production',
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Op {
  key: string; // "METHOD /path/{}"
  operationId: string;
  spec: 'admin' | 'store';
}

/** `/a/{storeId}/b` and `/a/:storeId/b` both → `/a/{}/b`. */
const shape = (path: string) =>
  path
    .replace(/\{[^}]+\}/g, '{}')
    .replace(/:[A-Za-z0-9_]+/g, '{}')
    .replace(/\/$/, '') || '/';

function contractOperations(): Op[] {
  const out: Op[] = [];
  for (const [spec, file] of [
    ['admin', 'admin-api.yaml'],
    ['store', 'store-api.yaml'],
  ] as const) {
    const paths = loadSpec(file).doc.paths as Record<
      string,
      Record<string, { operationId?: string }>
    >;
    for (const [path, item] of Object.entries(paths)) {
      for (const m of METHODS) {
        const op = item[m];
        if (!op) continue;
        if (!op.operationId)
          throw new Error(`${file}: ${m.toUpperCase()} ${path} has no operationId`);
        out.push({ key: `${m.toUpperCase()} ${shape(path)}`, operationId: op.operationId, spec });
      }
    }
  }
  return out;
}

interface Layer {
  route?: { path: unknown; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: unknown[];
}

/** The literal mount path of a `use(path, router)` layer, from Express 4's compiled regexp. */
function mountPrefix(layer: Layer): string {
  const re = layer.regexp!;
  if (re.fast_slash) return '';
  const m = /^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/.exec(re.source);
  if (!m || (layer.keys?.length ?? 0) > 0 || /[()[\]*+?|]/.test(m[1]!.replace(/\\\//g, ''))) {
    throw new Error(`cannot read the mount path of a router layer: /${re.source}/`);
  }
  return m[1]!.replace(/\\\//g, '/');
}

/** Every (METHOD, path) an Express app answers through a route, nested routers included. */
function mountedRoutes(stack: Layer[], prefix = ''): string[] {
  const out: string[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') throw new Error(`a route with a non-string path: ${String(p)}`);
        for (const [m, on] of Object.entries(layer.route.methods)) {
          if (on && m !== '_all') out.push(`${m.toUpperCase()} ${shape(prefix + p)}`);
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...mountedRoutes(layer.handle.stack, prefix + mountPrefix(layer)));
    }
  }
  return out;
}

/** The app createServer() composes (minus Medusa, which serves nothing of the contract). */
function servedByCore(): Set<string> {
  const app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    storeRegistrar: inMemoryStoreRegistrar(),
    moduleRouters: moduleAdminRouters(),
    storeRouters: moduleStoreRouters(),
    webhookRouters: moduleWebhookRouters(),
  });
  const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
  const served = new Set(mountedRoutes(stack));
  // hq-rbac answers its own table from one middleware (src/http/hq-rbac-adapter.ts): the same rule as createHqRbac
  const production = process.env.NODE_ENV === 'production';
  for (const r of production ? HQ_RBAC_ROUTES : [...HQ_RBAC_ROUTES, FINANCE_PING_ROUTE]) {
    served.add(`${r.method} ${shape(r.path)}`);
  }
  return served;
}

function table(rows: string[][]): string {
  return rows.map((r) => `  ${r.join('  |  ')}`).join('\n');
}

describe('contract coverage (#858)', () => {
  const ops = contractOperations();
  const served = servedByCore();

  it('reads a real app: the walk finds the core, module and hq-rbac routes', () => {
    expect(served.has('GET /admin/stores/{}/orders/{}')).toBe(true); // adminRouter
    expect(served.has('GET /store/products/{}')).toBe(true); // mountStoreRoutes
    expect(served.has('GET /admin/stores/{}/merchandising/rules')).toBe(true); // a module router
    expect(served.has('GET /admin/users')).toBe(true); // hq-rbac's table
    expect(ops.length).toBeGreaterThan(150);
  });

  it('every contract operation is served, or allowlisted with its issue', () => {
    const missing = ops.filter((o) => !served.has(o.key) && !(o.operationId in ALLOWLIST));
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} contract operation(s) have no mounted route and are not allowlisted:\n` +
          table(missing.map((o) => [o.spec, o.operationId, o.key])) +
          '\nServe them, or add `operationId: <issue>` to ALLOWLIST in test/contract-coverage.test.ts.',
      );
    }
  });

  it('every allowlisted operation is still unserved and still in the contract (the list only shrinks)', () => {
    const byId = new Map(ops.map((o) => [o.operationId, o]));
    const stale = Object.entries(ALLOWLIST).filter(([id]) => {
      const op = byId.get(id);
      return !op || served.has(op.key);
    });
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} allowlisted operation(s) are served now, or gone from the contract — delete them from ALLOWLIST:\n` +
          table(
            stale.map(([id, issue]) => [
              id,
              `#${issue}`,
              byId.get(id) ? `served: ${byId.get(id)!.key}` : 'not in the contract',
            ]),
          ),
      );
    }
  });

  it('nothing under /admin or /store is served outside the contract, except the named test double', () => {
    const inContract = new Set(ops.map((o) => o.key));
    const extra = [...served]
      .filter((k) => /^[A-Z]+ \/(admin|store)(\/|$)/.test(k) && !inContract.has(k))
      .sort();
    const unexplained = extra.filter((k) => !(k in NOT_IN_CONTRACT));
    if (unexplained.length > 0) {
      throw new Error(
        `${unexplained.length} route(s) under /admin or /store are not in the contract:\n` +
          table(unexplained.map((k) => [k])),
      );
    }
    expect(extra).toEqual(Object.keys(NOT_IN_CONTRACT).sort());
    // the test double is not part of the production table
    expect(HQ_RBAC_ROUTES.some((r) => r.path === FINANCE_PING_ROUTE.path)).toBe(false);
  });
});
