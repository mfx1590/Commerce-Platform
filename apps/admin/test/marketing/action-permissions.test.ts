/**
 * #925: the nine Marketing server actions refuse a principal without the operation's
 * `x-permission` BEFORE the Admin API is called — the #903 pattern. `MARKETING_PERMISSIONS` is
 * pinned to `admin-api.yaml`. Mutation-checked: deleting any one action's guard fails its
 * "refused before the API" case here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from '../fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/** A principal key, or a failed `/admin/me` answer (the session ended). */
const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string | { status: number } }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => {
    const current = principalOf.current;
    if (typeof current !== 'string') {
      return {
        ok: false,
        status: current.status,
        error: { code: 'unauthorized', message: 'session ended' },
      };
    }
    return {
      ok: true,
      status: 200,
      data: (await import('../fixtures/principals')).principals[current as PrincipalKey],
    };
  },
}));

const api = vi.hoisted(() => ({
  createCampaign: vi.fn(),
  launchCampaign: vi.fn(),
  endCampaign: vi.fn(),
  createSegment: vi.fn(),
  updateSegment: vi.fn(),
  previewSegment: vi.fn(),
  materializeSegment: vi.fn(),
  createFeed: vi.fn(),
  publishFeed: vi.fn(),
}));
vi.mock('@/app/(store)/[storeId]/marketing/_api', () => api);

const actions = await import('@/app/(store)/[storeId]/marketing/_actions');
const { MARKETING_PERMISSIONS } = await import('@/lib/marketing/permissions');

const STORE = SEED.stores.brandA;
const ID = '80000000-0000-4000-8000-000000000001';

interface Case {
  operation: keyof typeof api;
  call: (storeId?: string) => Promise<{ status: string }>;
  allowed: PrincipalKey;
  /** Reaches the store but lacks this operation's relation. */
  refused: PrincipalKey;
}

const CASES: Case[] = [
  {
    operation: 'createCampaign',
    call: (s = STORE) => actions.createCampaignAction(s, { name: 'Autumn' } as never),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
  },
  {
    operation: 'launchCampaign',
    call: (s = STORE) => actions.launchCampaignAction(s, ID),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
  },
  {
    operation: 'endCampaign',
    call: (s = STORE) => actions.endCampaignAction(s, ID),
    allowed: 'storeAdmin',
    refused: 'support',
  },
  {
    operation: 'createSegment',
    call: (s = STORE) => actions.createSegmentAction(s, { name: 'VIP' } as never),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
  },
  {
    operation: 'updateSegment',
    call: (s = STORE) => actions.updateSegmentAction(s, ID, { name: 'VIP' } as never),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
  },
  {
    operation: 'previewSegment',
    call: (s = STORE) => actions.previewSegmentAction(s, ID, {} as never),
    allowed: 'storeStaff',
    refused: 'analyst',
  },
  {
    operation: 'materializeSegment',
    call: (s = STORE) => actions.materializeSegmentAction(s, ID),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
  },
  {
    operation: 'createFeed',
    call: (s = STORE) => actions.createFeedAction(s, { name: 'Google' } as never),
    allowed: 'storeAdmin',
    refused: 'support',
  },
  {
    operation: 'publishFeed',
    call: (s = STORE) => actions.publishFeedAction(s, ID),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
  },
];

beforeEach(() => {
  for (const fn of Object.values(api)) {
    fn.mockReset();
    fn.mockResolvedValue({ ok: true, status: 200, data: { id: ID, count: 0 } });
  }
});

describe.each(CASES)('$operation', ({ operation, call, allowed, refused }) => {
  it(`refuses ${refused} with the contract's 403 before the API is called`, async () => {
    principalOf.current = refused;
    const result = await call();
    expect(api[operation]).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'error',
      refusal: { status: 403, error: { code: 'forbidden', details: { object: `store:${STORE}` } } },
    });
  });

  it('refuses on a store the principal holds nothing on (brand-c)', async () => {
    principalOf.current = allowed;
    expect(await call(SEED.stores.brandC)).toMatchObject({ status: 'error' });
    expect(api[operation]).not.toHaveBeenCalled();
  });

  it('refuses when the session ended (401), without calling the API', async () => {
    principalOf.current = { status: 401 };
    expect(await call()).toMatchObject({ status: 'error', refusal: { status: 401 } });
    expect(api[operation]).not.toHaveBeenCalled();
  });

  it('refuses a store id that is not a uuid', async () => {
    principalOf.current = 'owner';
    expect(await call('../brand-a')).toMatchObject({
      status: 'error',
      formError: 'That store is not valid.',
    });
    expect(api[operation]).not.toHaveBeenCalled();
  });

  it(`lets ${allowed} through to the API`, async () => {
    principalOf.current = allowed;
    await call();
    expect(api[operation]).toHaveBeenCalledTimes(1);
  });
});

describe('MARKETING_PERMISSIONS', () => {
  const spec = readFileSync(
    resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('are the x-permission admin-api.yaml carries', () => {
    for (const [operation, { relation }] of Object.entries(MARKETING_PERMISSIONS)) {
      const at = spec.indexOf(`operationId: ${operation}\n`);
      expect(at, operation).toBeGreaterThan(-1);
      const permission = /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
        spec.slice(at, at + 2000),
      );
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe('store:{storeId}');
    }
  });

  it('cover exactly the nine actions of #925', () => {
    expect(Object.keys(MARKETING_PERMISSIONS).sort()).toEqual(CASES.map((c) => c.operation).sort());
  });
});
