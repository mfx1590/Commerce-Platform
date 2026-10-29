// The contract operation matcher against the core's REAL `/admin` stack (#632, Fable review of #635): the agreement
// test in operation-matcher.test.ts builds a synthetic Express app from the spec, so a hand-written route that
// drifts from its contract template would pass there. Here the requests go through mountCoreMiddleware with
// moduleAdminRouters() — the exact chain server.ts mounts — and an x-op probe reports which Express route really
// handled each one. For every operation an Express route answers, the route must be the template the matcher
// resolved (parameter names aside); every allowlisted service-client operation MUST be answered by such a route.
// Pure: the verifier returns a fixed human scope, OpenFGA is a stub, the database clients are inert.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ORGANIZATION_RELATIONS,
  SERVICE_CLIENT_OPERATIONS,
  createOperationMatcher,
  type OpenFgaClient,
  type StaffRequestContext,
  type StaffScope,
} from '@platform/auth-sdk';
import { mountCoreMiddleware } from '../../../server';
import { moduleAdminRouters } from '../../../http/module-routers';
import type { StaffTokenVerifier } from '../../../http/staff-auth';
import type * as Db from '../../../lib/db';

// The principal lists its store from the organization client, and hq-rbac takes the pool on a path it does not
// own; inert ones keep the probe pure (the store row is canned, any pool query throws).
vi.mock('../../../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  organizationClient: () => ({
    query: async () => ({
      rows: [
        { id: '00000000-0000-4000-8000-000000000031', code: 'probe', name: 'Probe', relations: [] },
      ],
    }),
  }),
  getPool: () => ({
    query: async () => {
      throw new Error('router probe: no database');
    },
    connect: async () => {
      throw new Error('router probe: no database');
    },
  }),
}));

const here = dirname(fileURLToPath(import.meta.url));
const matcher = createOperationMatcher(
  (
    parse(
      readFileSync(
        resolve(here, '../../../../../../packages/contracts/openapi/admin-api.yaml'),
        'utf8',
      ),
    ) as { paths: Record<string, Record<string, unknown>> }
  ).paths,
);

const ID = '00000000-0000-4000-8000-000000000031';
const isParam = (s: string) => /^\{[^}]+\}$/.test(s) || s.startsWith(':');
/** A template's shape, parameter names aside: `/admin/stores/:` for `/admin/stores/{storeId}` and `/admin/stores/:id`. */
const shape = (template: string) =>
  template
    .split('/')
    .map((s) => (isParam(s) ? ':' : s.toLowerCase()))
    .join('/');

const SCOPE: StaffScope = {
  userId: ID,
  subject: 'router-probe',
  email: 'probe@example.invalid',
  displayName: 'Router probe',
  organizationId: ID,
  // Every HQ relation and the probed store in scope: the scope checks in front of the routes pass.
  organizationRelations: [...ORGANIZATION_RELATIONS],
  storeIds: [ID],
  scope: 'organization',
};
// Every OpenFGA check allows, so a permission check in front of the routes lets the request reach them; the probe
// answers before any handler runs, so nothing is ever done with that permission.
const fga = new Proxy({} as OpenFgaClient, {
  get: () => async () => ({ allowed: true, objects: [] }),
});

function probeApp() {
  const resolved: (string | undefined)[] = [];
  const verifier: StaffTokenVerifier = {
    async verify(_token, req?: StaffRequestContext) {
      resolved.push(req?.operationId);
      return { subject: SCOPE.subject, scope: SCOPE, fga };
    },
  };
  const app = express();
  mountCoreMiddleware(app, verifier, { fga, moduleRouters: moduleAdminRouters() });
  return { app, resolved };
}

// The x-op probe: the FIRST Express route the request is dispatched to answers 204 with its path, before any of
// its handlers run (so no handler acts). Express 4 binds `route.dispatch` when a route is created, so the
// prototype is patched BEFORE the app is built, and restored after.
type Dispatch = (req: express.Request, res: express.Response, done: express.NextFunction) => void;
const RouteProto = (
  express as unknown as { Route: { prototype: { path: string; dispatch: Dispatch } } }
).Route.prototype;
const dispatch = RouteProto.dispatch;
afterAll(() => {
  RouteProto.dispatch = dispatch;
});

const ALLOWLISTED = new Set(Object.values(SERVICE_CLIENT_OPERATIONS).flatMap((apis) => apis.admin));

describe("the matcher agrees with the core's real /admin routers (#632)", () => {
  let probe: ReturnType<typeof probeApp>;
  const answered = new Set<string>();
  beforeAll(() => {
    RouteProto.dispatch = function (this: { path: unknown }, req, res) {
      res.setHeader('x-op', req.baseUrl + String(this.path));
      res.status(204).end();
    };
    probe = probeApp();
  });

  it.each(matcher.operations.map((o) => [o.method.toUpperCase(), o.template, o.operationId]))(
    '%s %s (%s)',
    async (method, template, operationId) => {
      const path = template.replace(/\{[^}]+\}/g, ID);
      const { app, resolved } = probe;
      resolved.length = 0;
      const res = await request(app)
        [method.toLowerCase() as 'get'](path)
        .set('authorization', 'Bearer router.probe.token');
      // The staff middleware resolved this very operation before routing.
      expect(resolved).toEqual([operationId]);
      const route = res.headers['x-op'] as string | undefined;
      if (route !== undefined) {
        answered.add(operationId);
        expect(shape(route), `${method} ${path} ran ${route}`).toBe(shape(template));
      }
      if (ALLOWLISTED.has(operationId)) {
        expect(route, `${operationId} must be answered by a core route`).toBeDefined();
      }
    },
  );

  it('the walk saw real routes, every allowlisted Admin operation among them', () => {
    expect(answered.size).toBeGreaterThan(20);
    for (const op of ALLOWLISTED) expect(answered.has(op), op).toBe(true);
  });
});
