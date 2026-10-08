// The interim OpenFGA adapter behind store onboarding (#413; window 2's ensureStoreObject replaces its body, #415).
import type { OpenFgaClient } from '@platform/auth-sdk';
import { describe, expect, it } from 'vitest';
import { openFgaStoreRegistrar } from '../src/http/store-registrar';

const STORE = '00000000-0000-4000-8000-000000000099';
const TUPLE = { user: 'organization:hq', relation: 'organization', object: `store:${STORE}` };

/** A stub with only the two calls the adapter makes. */
function stub(opts: { present?: boolean; writeError?: Error; checkError?: Error } = {}) {
  const writes: unknown[] = [];
  const checks: unknown[] = [];
  let present = opts.present ?? false;
  const fga = {
    async check(t: unknown) {
      checks.push(t);
      if (opts.checkError) throw opts.checkError;
      return { allowed: present };
    },
    async write(body: { writes: unknown[] }) {
      writes.push(...body.writes);
      if (opts.writeError) throw opts.writeError;
      present = true;
      return {};
    },
  } as unknown as OpenFgaClient;
  return { fga, writes, checks };
}

describe('openFgaStoreRegistrar (#413)', () => {
  it('writes the organization:hq tuple once; a present tuple is not written again', async () => {
    const s = stub();
    const registrar = openFgaStoreRegistrar(s.fga);
    expect(await registrar.hasStoreObject(STORE)).toBe(false);
    await registrar.ensureStoreObject(STORE);
    await registrar.ensureStoreObject(STORE);
    expect(s.writes).toEqual([TUPLE]);
    expect(await registrar.hasStoreObject(STORE)).toBe(true);
    expect(s.checks.every((c) => JSON.stringify(c) === JSON.stringify(TUPLE))).toBe(true);
  });

  it('a concurrent duplicate write is tolerated; anything else from OpenFGA is a 503 (fail closed)', async () => {
    const dup = stub({
      writeError: new Error('write_failed_due_to_invalid_input: tuple already exists'),
    });
    await expect(openFgaStoreRegistrar(dup.fga).ensureStoreObject(STORE)).resolves.toBeUndefined();

    const down = stub({ checkError: new Error('connect ECONNREFUSED 127.0.0.1:8081') });
    await expect(openFgaStoreRegistrar(down.fga).hasStoreObject(STORE)).rejects.toMatchObject({
      code: 'internal',
      status: 503,
    });
    const refused = stub({ writeError: new Error('socket hang up') });
    await expect(openFgaStoreRegistrar(refused.fga).ensureStoreObject(STORE)).rejects.toMatchObject(
      {
        status: 503,
      },
    );
  });

  it('refuses a non-uuid store id before talking to OpenFGA; the organization slug is configurable', async () => {
    const s = stub();
    await expect(openFgaStoreRegistrar(s.fga).ensureStoreObject('brand-a')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(s.checks).toEqual([]);
    await openFgaStoreRegistrar(s.fga, { organization: 'other' }).ensureStoreObject(STORE);
    expect(s.writes).toEqual([{ ...TUPLE, user: 'organization:other' }]);
  });
});
