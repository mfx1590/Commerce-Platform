import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, principals } from './fixtures/principals';

const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    // next/navigation's redirect throws to unwind the render; mimic that so code after it
    // is genuinely unreachable, which is what the "does not remember" assertions rely on.
    throw new Error(`REDIRECT:${path}`);
  }),
);
const loadPrincipal = vi.hoisted(() => vi.fn());
const rememberStoreId = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/lib/principal', () => ({ loadPrincipal }));
vi.mock('@/lib/nav/selected-store', () => ({ rememberStoreId }));

const { selectStore } = await import('@/app/actions/select-store');

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function run(fields: Record<string, string>): Promise<string> {
  try {
    await selectStore(form(fields));
  } catch (error) {
    return (error as Error).message.replace('REDIRECT:', '');
  }
  throw new Error('expected the action to redirect');
}

beforeEach(() => {
  vi.clearAllMocks();
  loadPrincipal.mockResolvedValue({ ok: true, status: 200, data: principals.storeAdmin });
});

describe('selectStore', () => {
  it('remembers an allowed store and lands on the requested section', async () => {
    const target = await run({ storeId: SEED.stores.brandB, section: 'orders' });
    expect(rememberStoreId).toHaveBeenCalledWith(SEED.stores.brandB);
    expect(target).toEqual(`/${SEED.stores.brandB}/orders`);
  });

  it('defaults to catalog when no section travels with the switch', async () => {
    const target = await run({ storeId: SEED.stores.brandA });
    expect(target).toEqual(`/${SEED.stores.brandA}/catalog`);
  });

  it('refuses a store outside stores[] and never remembers it', async () => {
    // A hand-edited <option value> is the realistic attack here.
    const target = await run({ storeId: SEED.stores.brandC, section: 'settings' });
    expect(rememberStoreId).not.toHaveBeenCalled();
    expect(target).toEqual(`/${SEED.stores.brandC}`);
  });

  it('refuses an arbitrary id', async () => {
    await run({ storeId: 'not-a-store' });
    expect(rememberStoreId).not.toHaveBeenCalled();
  });

  it('refuses everything when the principal could not be loaded', async () => {
    loadPrincipal.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'forbidden', message: 'nope' },
    });
    await run({ storeId: SEED.stores.brandA });
    expect(rememberStoreId).not.toHaveBeenCalled();
  });

  it('sends an empty submission home', async () => {
    const target = await run({ storeId: '' });
    expect(target).toEqual('/');
    expect(rememberStoreId).not.toHaveBeenCalled();
  });
});
