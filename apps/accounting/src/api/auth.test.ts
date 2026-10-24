// Finance authorization edge cases (Fable review of #582, for #552's PR): dev tokens are refused in production
// whatever the flag says, refused outside production when the flag is off, accepted with the flag; a permission
// service that cannot answer is a 503 (fail closed), a refusal a 403 with the contract's details. No database: the
// client is a stub that only answers the staff_user lookup.
import type { ScopedClient } from '@platform/db';
import { describe, expect, it } from 'vitest';
import { ApiError, createFinanceAuth } from './auth.js';

const STAFF_ID = '00000000-0000-4000-8000-000000000042';
const stubClient = (rows: { id: string }[] = [{ id: STAFF_ID }], calls: string[] = []) =>
  ({
    query: async (text: string) => {
      calls.push(text);
      return { rows, rowCount: rows.length };
    },
  }) as unknown as ScopedClient;
const verifier = { verify: async (token: string) => ({ subject: token }) };
const permission = { relation: 'finance', object: 'organization:hq' };

describe('dev tokens', () => {
  it('are never accepted in production, even with the flag set — and the database is not asked', async () => {
    const calls: string[] = [];
    const auth = createFinanceAuth({
      client: stubClient([{ id: STAFF_ID }], calls),
      devTokens: true,
      verifier,
      env: { NODE_ENV: 'production' },
    });
    await expect(auth.authenticate('Bearer dev:seed-finance')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'dev tokens are never accepted in production',
    });
    expect(calls).toEqual([]);
  });

  it('are refused outside production when ACCOUNTING_DEV_TOKENS is off, and accepted when it is on', async () => {
    const off = createFinanceAuth({ client: stubClient(), devTokens: false, verifier, env: {} });
    await expect(off.authenticate('Bearer dev:seed-finance')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('ACCOUNTING_DEV_TOKENS=1'),
    });
    const on = createFinanceAuth({ client: stubClient(), devTokens: true, verifier, env: {} });
    expect(await on.authenticate('Bearer dev:seed-finance')).toEqual({
      subject: 'seed-finance',
      staffUserId: STAFF_ID,
    });
    await expect(on.authenticate('Bearer dev:')).rejects.toMatchObject({ status: 401 });
    await expect(on.authenticate(undefined)).rejects.toMatchObject({
      status: 401,
      message: 'Missing bearer token',
    });
  });

  it('a real token whose subject is not an active staff user is 401', async () => {
    const auth = createFinanceAuth({ client: stubClient([]), devTokens: false, verifier, env: {} });
    await expect(auth.authenticate('Bearer somebody')).rejects.toMatchObject({
      status: 401,
      message: 'unknown or disabled staff user',
    });
  });
});

describe('authorize', () => {
  const principal = { subject: 'seed-finance', staffUserId: STAFF_ID };

  it('a permission service that cannot answer is a 503 with the relation and object (fail closed), never a 200', async () => {
    const auth = createFinanceAuth({
      client: stubClient(),
      devTokens: false,
      verifier,
      permission: async () => {
        throw new Error('OpenFGA unreachable');
      },
    });
    const err = await auth.authorize(principal, permission).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 503,
      code: 'internal',
      details: { relation: 'finance', object: 'organization:hq' },
    });
  });

  it("a refusal is the contract's 403; a grant resolves", async () => {
    const asked: string[] = [];
    const auth = createFinanceAuth({
      client: stubClient(),
      devTokens: false,
      verifier,
      permission: async (staffUserId, relation, object) => {
        asked.push(`${staffUserId} ${relation} ${object}`);
        return relation === 'finance' && staffUserId === STAFF_ID;
      },
    });
    await expect(auth.authorize(principal, permission)).resolves.toBeUndefined();
    await expect(
      auth.authorize(
        { subject: 'seed-store-admin', staffUserId: '00000000-0000-4000-8000-000000000044' },
        permission,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Not allowed',
      details: { relation: 'finance', object: 'organization:hq' },
    });
    expect(asked).toEqual([
      `${STAFF_ID} finance organization:hq`,
      '00000000-0000-4000-8000-000000000044 finance organization:hq',
    ]);
  });
});
