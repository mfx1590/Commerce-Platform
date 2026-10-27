// The contract operation matcher (#632) against the REAL contracts and the REAL router (manager's conditions):
// 1. every operation of admin-api.yaml / accounting.yaml, built into a concrete path from its template, matches
//    exactly that operation (no ambiguity, literal segments beat parameters);
// 2. Express 4 (the core's router, apps/core's version) agrees on every operation and on the variants Express
//    accepts or refuses: trailing slash, case, %-encoded parameter values, query, HEAD, doubled slashes — so the
//    matcher normalises nothing the router does not, and vice versa;
// 3. no allowlisted service-client operation is ever chosen over an overlapping one: whatever order a module
//    registers its routes in, a path the matcher resolves to an allowed operation cannot run another one.
// Pure (no stack): Express listens on 127.0.0.1:0, requests go through node:http with the raw path (no URL
// normalisation on the way).
import { readFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SERVICE_CLIENT_OPERATIONS,
  createOperationMatcher,
  type OperationMatch,
} from '@platform/auth-sdk';

const here = dirname(fileURLToPath(import.meta.url));
type Paths = Record<string, Record<string, unknown>>;
const pathsOf = (file: string): Paths =>
  (
    parse(
      readFileSync(resolve(here, '../../../../../../packages/contracts/openapi', file), 'utf8'),
    ) as { paths: Paths }
  ).paths;

const SPECS = { admin: pathsOf('admin-api.yaml'), finance: pathsOf('accounting.yaml') } as const;
const MATCHERS = {
  admin: createOperationMatcher(SPECS.admin),
  finance: createOperationMatcher(SPECS.finance),
};

const isParam = (s: string) => /^\{[^}]+\}$/.test(s);
const segmentsOf = (template: string) => template.slice(1).split('/');
/** A concrete path for a template: every parameter gets `value(i)`. */
const concrete = (template: string, value: (i: number) => string) =>
  '/' +
  segmentsOf(template)
    .map((s, i) => (isParam(s) ? value(i) : s))
    .join('/');
const rankOf = (template: string) => segmentsOf(template).map((s) => (isParam(s) ? 1 : 0));

describe('every contract operation matches exactly itself (#632)', () => {
  for (const [api, matcher] of Object.entries(MATCHERS)) {
    it(`${api}: ${matcher.operations.length} operations, no ambiguity`, () => {
      expect(matcher.operations.length).toBeGreaterThan(api === 'admin' ? 50 : 5);
      const ids = matcher.operations.map((o) => o.operationId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const o of matcher.operations) {
        const path = concrete(o.template, (i) => `v${i}x`);
        expect(
          matcher.match(o.method.toUpperCase(), path)?.operationId,
          `${o.method} ${path}`,
        ).toBe(o.operationId);
      }
    });
  }

  it('literal beats parameter wherever the contracts have both', () => {
    let pairs = 0;
    for (const matcher of Object.values(MATCHERS)) {
      for (const a of matcher.operations) {
        for (const b of matcher.operations) {
          if (a === b || a.method !== b.method) continue;
          const sa = segmentsOf(a.template);
          const sb = segmentsOf(b.template);
          if (sa.length !== sb.length) continue;
          // b has a literal exactly where a has a parameter, everything else compatible → b wins on b's path.
          const witness = sa.map((s, i) => (!isParam(s) ? s : !isParam(sb[i]!) ? sb[i]! : `w${i}`));
          if (!sb.every((s, i) => isParam(s) || s.toLowerCase() === witness[i]!.toLowerCase()))
            continue;
          if (!sa.every((s, i) => isParam(s) || s.toLowerCase() === witness[i]!.toLowerCase()))
            continue;
          const winner = rankOf(a.template).join() < rankOf(b.template).join() ? a : b;
          expect(matcher.match(a.method, '/' + witness.join('/'))?.operationId).toBe(
            winner.operationId,
          );
          pairs++;
        }
      }
    }
    // Today neither contract has such a pair (pairs = 0): this walk guards future contract additions; the rule
    // itself is proven on a synthetic spec in packages/auth-sdk/test/operation-matcher.test.ts.
    expect(pairs).toBeGreaterThanOrEqual(0);
  });
});

describe('agreement with Express 4 on the Admin API (#632)', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    const app = express();
    // Literal-first registration (OpenAPI's rule); part 3 below shows the allowlist does not depend on it.
    const ops = [...MATCHERS.admin.operations].sort((x, y) =>
      rankOf(x.template).join() < rankOf(y.template).join() ? -1 : 1,
    );
    for (const o of ops) {
      const route = o.template.replace(/\{([^}]+)\}/g, ':$1');
      (app as unknown as Record<string, (p: string, h: express.RequestHandler) => void>)[o.method]!(
        route,
        (_req, res) => {
          res.set('x-op', o.operationId).status(204).end();
        },
      );
    }
    app.use((_req, res) => {
      res.status(404).end();
    });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const a = server.address();
    if (!a || typeof a === 'string') throw new Error('no port');
    port = a.port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** The operation Express ran for a raw method + path, or null (404). */
  const routed = (method: string, path: string) =>
    new Promise<string | null>((done, fail) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path }, (res) => {
        res.resume();
        res.on('end', () => done((res.headers['x-op'] as string | undefined) ?? null));
      });
      req.on('error', fail);
      req.end();
    });

  const variants = (o: OperationMatch): string[] => {
    const plain = concrete(o.template, (i) => `v${i}x`);
    return [
      plain,
      plain + '/',
      plain + '//',
      plain + '?q=1&next=/admin/me',
      plain.toUpperCase(),
      concrete(o.template, () => 'a%2Fb'),
      concrete(o.template, () => '%41b'),
      concrete(o.template, () => 'a.b'),
      concrete(o.template, () => ''),
      plain.replace('/admin/', '/admin//'),
    ];
  };

  it('every operation × every variant: the matcher picks what Express runs (or both refuse)', async () => {
    let checked = 0;
    for (const o of MATCHERS.admin.operations) {
      const methods = o.method === 'get' ? ['GET', 'HEAD'] : [o.method.toUpperCase()];
      for (const method of methods) {
        for (const path of variants(o)) {
          const express_ = await routed(method, path);
          const ours = MATCHERS.admin.match(method, path)?.operationId ?? null;
          expect(ours, `${method} ${path}`).toBe(express_);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe('allowlisted operations are never chosen over an overlapping operation (#632)', () => {
  it('for every allowed operation, any same-method template that can match the same path wins over it', () => {
    let allowed = 0;
    for (const apis of Object.values(SERVICE_CLIENT_OPERATIONS)) {
      for (const [api, ids] of Object.entries(apis) as ['admin' | 'finance', string[]][]) {
        const matcher = MATCHERS[api];
        for (const id of ids) {
          const a = matcher.operations.find((o) => o.operationId === id);
          expect(a, `${api} ${id} exists in the contract`).toBeDefined();
          allowed++;
          for (const b of matcher.operations) {
            if (b === a || b.method !== a!.method) continue;
            const sa = segmentsOf(a!.template);
            const sb = segmentsOf(b.template);
            if (sa.length !== sb.length) continue;
            const compatible = sa.every(
              (s, i) => isParam(s) || isParam(sb[i]!) || s.toLowerCase() === sb[i]!.toLowerCase(),
            );
            if (!compatible) continue;
            const witness =
              '/' +
              sa.map((s, i) => (!isParam(s) ? s : !isParam(sb[i]!) ? sb[i]! : `w${i}`)).join('/');
            // A path both could serve must never resolve to the allowed one: a router that registered b first
            // would run b while the guard allowed a.
            expect(matcher.match(a!.method, witness)?.operationId, `${witness}`).not.toBe(id);
          }
        }
      }
    }
    expect(allowed).toBe(8);
  });
});
