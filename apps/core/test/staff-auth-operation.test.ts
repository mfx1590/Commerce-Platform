// #632 (window 2, integration exception): the `/admin` staff middleware resolves the contract operation BEFORE
// routing and hands { method, api: 'admin', operationId } to the verifier, so auth-sdk can refuse a service client
// outside its allowlist. Mounted at `/admin` as in server.ts: the operation must come from the ORIGINAL path, not
// the mount-stripped `req.path`. Pure: a recording verifier, no stack.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { StaffRequestContext } from '@platform/auth-sdk';
import { staffAuthMiddleware, type StaffTokenVerifier } from '../src/http/staff-auth';
import { AppError } from '../src/lib/errors';

function appRecording() {
  const seen: (StaffRequestContext | undefined)[] = [];
  const verifier: StaffTokenVerifier = {
    async verify(_token, req) {
      seen.push(req);
      throw new AppError('unauthorized', 'recording verifier');
    },
  };
  const app = express();
  app.use('/admin', staffAuthMiddleware(verifier));
  app.use(((_err, _req, res, _next) => {
    res.status(401).end();
  }) as express.ErrorRequestHandler);
  return { app, seen };
}

const STORE = '00000000-0000-4000-8000-000000000031';

describe('staffAuthMiddleware passes the Admin API operation to the verifier (#632)', () => {
  it.each([
    ['GET', `/admin/stores/${STORE}/customers`, 'listCustomers'],
    ['GET', `/admin/stores/${STORE}/customers/c1?limit=5`, 'getCustomer'],
    ['HEAD', `/admin/stores/${STORE}/customers/`, 'listCustomers'],
    ['GET', `/ADMIN/Stores/${STORE}/Customers`, 'listCustomers'],
    ['GET', `/admin/stores/${STORE}/orders`, 'listOrders'],
    ['POST', '/admin/users', 'inviteUser'],
    ['GET', '/admin/no-such-operation', undefined],
    ['GET', `/admin//stores/${STORE}/customers`, undefined],
  ])('%s %s → %s', async (method, path, operationId) => {
    const { app, seen } = appRecording();
    await request(app)
      [method.toLowerCase() as 'get'](path)
      .set('authorization', 'Bearer some.jwt.value')
      .expect(401);
    expect(seen).toEqual([{ method, api: 'admin', operationId }]);
  });
});
