// BI v2 (#871 e): the model reads aliases, the owner reads names. The substitution happens on the server, after the
// model answered, so no product or category title ever enters the prompt.
import { describe, expect, it } from 'vitest';
import { Aliases, substituteAliases } from './tool';

const P1 = '00000000-0000-4000-8000-0000000000p1'.replace('p1', 'b1');
const P2 = '00000000-0000-4000-8000-0000000000b2';
const CAT = '00000000-0000-4000-8000-0000000000c1';
const ITEM = '00000000-0000-4000-8000-0000000000d1';

describe('substituteAliases', () => {
  it('replaces whole-token aliases the question issued, keeps the rest, names stock items without a lookup', async () => {
    const a = new Aliases();
    expect(a.of('product', P1)).toBe('p1');
    expect(a.of('product', P2)).toBe('p2');
    expect(a.of('product', P1)).toBe('p1'); // stable for the whole question
    expect(a.of('category', CAT)).toBe('c1');
    expect(a.of('item', ITEM)).toBe('i1');
    a.known.set('i1', 'Blue mug (MUG-1)');
    const asked: unknown[] = [];
    const r = await substituteAliases(
      'Top: p1 then p2 (c1). Reorder i1. p12 and w9 were never issued; up1 is not a token.',
      a,
      async (ids) => {
        asked.push(ids);
        return { product: { [P1]: 'Red mug', [P2]: 'Teapot' }, category: { [CAT]: 'Kitchen' } };
      },
    );
    expect(r.text).toBe(
      'Top: Red mug then Teapot (Kitchen). Reorder Blue mug (MUG-1). p12 and w9 were never issued; up1 is not a token.',
    );
    expect(r.legend).toEqual({
      p1: 'Red mug',
      p2: 'Teapot',
      c1: 'Kitchen',
      i1: 'Blue mug (MUG-1)',
    });
    // one resolve call, never for the stock item (its name came with the inventory result)
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual({ product: new Set([P1, P2]), category: new Set([CAT]) });
  });

  it('an alias without a name (a record the caller cannot read) stays as written', async () => {
    const a = new Aliases();
    a.of('product', P1);
    const r = await substituteAliases('Only p1.', a, async () => ({}));
    expect(r).toEqual({ text: 'Only p1.', legend: {} });
  });
});
