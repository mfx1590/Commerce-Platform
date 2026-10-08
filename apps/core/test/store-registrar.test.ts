// The OpenFGA StoreRegistrar behind store onboarding (#413): writes through window 2's ensureStoreObject (#421),
// checks by reading the same tuple; auth-sdk errors arrive as the core's AppErrors.
import type { OpenFgaClient } from '@platform/auth-sdk';
import { describe, expect, it } from 'vitest';
import { openFgaStoreRegistrar } from '../src/http/store-registrar';

const STORE = '00000000-0000-4000-8000-000000000099';
const TUPLE = { user: 'organization:hq', relation: 'organization', object: `store:${STORE}` };

/** A stub with only the two calls the adapter (and ensureStoreObject) make: read and write. */
function stub(opts: { present?: boolean; writeError?: unknown; readError?: unknown } = {}) {
  const writes: unknown[] = [];
  const reads: unknown[] = [];
  let present = opts.present ?? false;
  const fga = {
    async read(t: unknown) {
      reads.push(t);
      if (opts.readError) throw opts.readError;
      return { tuples: present ? [{ key: TUPLE }] : [] };
    },
    async write(body: { writes: unknown[] }) {
      writes.push(...body.writes);
      if (opts.writeError) throw opts.writeError;
      present = true;
      return {};
    },
  } as unknown as OpenFgaClient;
  return { fga, writes, reads };
}

describe('openFgaStoreRegistrar (#413, ensureStoreObject from #421)', () => {
  it('writes the organization:hq tuple once; a present tuple is not written again', async () => {
    const s = stub();
    const registrar = openFgaStoreRegistrar(s.fga);
    expect(await registrar.hasStoreObject(STORE)).toBe(false);
    await registrar.ensureStoreObject(STORE);
    await registrar.ensureStoreObject(STORE);
    expect(s.writes).toEqual([TUPLE]);
    expect(await registrar.hasStoreObject(STORE)).toBe(true);
    for (const r of s.reads) expect(r).toEqual(TUPLE);
  });

  it('a concurrent duplicate write is tolerated; OpenFGA down is a 503 (fail closed)', async () => {
    const duplicate = Object.assign(new Error('tuple already exists'), { statusCode: 400 });
    await expect(
      openFgaStoreRegistrar(stub({ writeError: duplicate }).fga).ensureStoreObject(STORE),
    ).resolves.toBeUndefined();

    const down = new Error('connect ECONNREFUSED 127.0.0.1:8081');
    await expect(
      openFgaStoreRegistrar(stub({ readError: down }).fga).hasStoreObject(STORE),
    ).rejects.toMatchObject({ code: 'internal', status: 503 });
    await expect(
      openFgaStoreRegistrar(stub({ readError: down }).fga).ensureStoreObject(STORE),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('refuses a non-uuid store id before talking to OpenFGA; the organization slug is configurable', async () => {
    const s = stub();
    await expect(openFgaStoreRegistrar(s.fga).ensureStoreObject('brand-a')).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
    });
    await expect(openFgaStoreRegistrar(s.fga).hasStoreObject('brand-a')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(s.reads).toEqual([]);
    await openFgaStoreRegistrar(s.fga, { organization: 'other' }).ensureStoreObject(STORE);
    expect(s.writes).toEqual([{ ...TUPLE, user: 'organization:other' }]);
  });
});
