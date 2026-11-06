// #740: a client's X-Request-Id is kept only in a safe shape; anything else is replaced by a generated uuid, as if
// none was sent. The id reaches audit_log.request_id, the span and the outbox envelope's trace.request_id.
import type { Request } from 'express';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requestIdMiddleware, requestIdOf } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reqWith = (id: string | string[] | undefined) =>
  ({ headers: id === undefined ? {} : { 'x-request-id': id } }) as unknown as Request;

describe('requestIdOf (#740)', () => {
  it.each([
    ['an e-mail', 'dora@example.test'],
    ['a control character', 'abc\u0001def'],
    ['a newline', 'abc\ndef'],
    ['a 200-character string', 'a'.repeat(200)],
    ['129 characters', 'a'.repeat(129)],
    ['a space', 'abc def'],
    ['an empty string', ''],
  ])('replaces %s with a generated uuid, written back onto the request', (_what, unsafe) => {
    const req = reqWith(unsafe);
    const id = requestIdOf(req);
    expect(id).toMatch(UUID);
    expect(req.headers['x-request-id']).toBe(id);
    expect(requestIdOf(req)).toBe(id); // stable for the request
  });

  it.each([
    ['a uuid', '7b0e4c3a-1f2d-4e5a-9b8c-0d1e2f3a4b5c'],
    ['abc-123', 'abc-123'],
    ['the other safe characters', 'Proxy_1.2:3-x'],
    ['128 characters', 'a'.repeat(128)],
  ])('keeps %s', (_what, safe) => {
    expect(requestIdOf(reqWith(safe))).toBe(safe);
  });

  it('generates one when none is sent, and reads the first of a repeated header', () => {
    expect(requestIdOf(reqWith(undefined))).toMatch(UUID);
    expect(requestIdOf(reqWith(['abc-123', 'dora@example.test']))).toBe('abc-123');
    expect(requestIdOf(reqWith(['dora@example.test', 'abc-123']))).toMatch(UUID);
  });

  it('the response echoes the id actually used, never the unsafe one', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/x', (req, res) => res.json({ id: requestIdOf(req) }));
    const unsafe = await request(app)
      .get('/x')
      .set('X-Request-Id', 'dora@example.test')
      .expect(200);
    expect(unsafe.headers['x-request-id']).toMatch(UUID);
    expect(unsafe.body.id).toBe(unsafe.headers['x-request-id']);
    const long = await request(app).get('/x').set('X-Request-Id', 'a'.repeat(200)).expect(200);
    expect(long.headers['x-request-id']).toMatch(UUID);
    const kept = await request(app).get('/x').set('X-Request-Id', 'abc-123').expect(200);
    expect(kept.headers['x-request-id']).toBe('abc-123');
  });
});
