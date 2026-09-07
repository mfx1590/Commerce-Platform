/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createProduct = vi.hoisted(() => vi.fn());
const updateProduct = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/admin', () => ({
  createProduct,
  updateProduct,
  archiveProduct: vi.fn(),
  createCategory: vi.fn(),
  createVariant: vi.fn(),
  publishProduct: vi.fn(),
  updateVariant: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { createProductAction, updateProductAction } = await import('@/app/actions/catalog');

const base = { handle: 'classic-tee', title: 'Classic Tee' };
const image = (url: string, position?: number) => ({
  url,
  ...(position === undefined ? {} : { position }),
});

/** What the action actually sent to the Admin API. */
function sentMedia(mock: typeof createProduct): { url: string; position: number }[] {
  const body = mock.mock.calls[0]?.[1] as { media?: { url: string; position: number }[] };
  return body.media ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  createProduct.mockResolvedValue({ ok: true, status: 201, data: { id: 'p1' } });
  updateProduct.mockResolvedValue({ ok: true, status: 200, data: { id: 'p1' } });
});

describe('media positions are renumbered from the array order', () => {
  it('numbers a fresh list from zero', async () => {
    await createProductAction('s1', {
      ...base,
      media: [image('https://x/a.jpg'), image('https://x/b.jpg'), image('https://x/c.jpg')],
    });
    expect(sentMedia(createProduct).map((m) => m.position)).toEqual([0, 1, 2]);
  });

  it('closes the gap left by removing the first image', async () => {
    // The form assigns a position on append and never revisits it, so after a removal the surviving
    // rows carried 1 and 2 with no 0. The array order is what the user sees, so it is what is sent.
    await createProductAction('s1', {
      ...base,
      media: [image('https://x/b.jpg', 1), image('https://x/c.jpg', 2)],
    });
    expect(sentMedia(createProduct).map((m) => m.position)).toEqual([0, 1]);
  });

  it('refuses to send a duplicate position', async () => {
    // Remove the middle of three, then append: the new row reused a number already in use.
    await createProductAction('s1', {
      ...base,
      media: [
        image('https://x/a.jpg', 0),
        image('https://x/c.jpg', 2),
        image('https://x/d.jpg', 2),
      ],
    });
    const positions = sentMedia(createProduct).map((m) => m.position);
    expect(positions).toEqual([0, 1, 2]);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('keeps the order the user arranged, not the numbers they arrived with', async () => {
    await createProductAction('s1', {
      ...base,
      media: [image('https://x/c.jpg', 9), image('https://x/a.jpg', 3)],
    });
    expect(sentMedia(createProduct)).toEqual([
      { url: 'https://x/c.jpg', position: 0 },
      { url: 'https://x/a.jpg', position: 1 },
    ]);
  });

  it('does the same on update', async () => {
    await updateProductAction('s1', 'p1', {
      ...base,
      media: [image('https://x/b.jpg', 5), image('https://x/a.jpg', 5)],
    });
    const body = updateProduct.mock.calls[0]?.[2] as { media: { position: number }[] };
    expect(body.media.map((m) => m.position)).toEqual([0, 1]);
  });

  it('sends no media key at all when there are none', async () => {
    await createProductAction('s1', base);
    const body = createProduct.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('media' in body).toBe(false);
  });

  it('sends an empty list as an empty list', async () => {
    await createProductAction('s1', { ...base, media: [] });
    expect(sentMedia(createProduct)).toEqual([]);
  });
});
