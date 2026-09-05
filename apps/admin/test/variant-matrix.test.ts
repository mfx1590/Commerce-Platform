import { describe, expect, it } from 'vitest';
import { suggestSku, variantCount, variantMatrix, variantTitle } from '@/lib/forms/variant-matrix';

const size = { name: 'Size', values: ['S', 'M', 'L'] };
const colour = { name: 'Colour', values: ['Red', 'Blue'] };

describe('variantMatrix', () => {
  it('is the cross-product, not a merge of the lists', () => {
    // The mistake worth guarding: 3 sizes and 2 colours is 6 variants, not 3 or 5.
    expect(variantMatrix([size, colour])).toHaveLength(6);
    expect(variantCount([size, colour])).toBe(6);
  });

  it('grows the way an operator expects when a value is added', () => {
    expect(variantCount([size, colour])).toBe(6);
    expect(variantCount([size, { name: 'Colour', values: ['Red', 'Blue', 'Green'] }])).toBe(9);
  });

  it('varies the last option fastest, so the list reads like the inputs', () => {
    expect(
      variantMatrix([size, colour]).map((combo) => variantTitle(combo, [size, colour])),
    ).toEqual(['S / Red', 'S / Blue', 'M / Red', 'M / Blue', 'L / Red', 'L / Blue']);
  });

  it('produces one variant per value for a single option', () => {
    expect(variantMatrix([size])).toEqual([{ Size: 'S' }, { Size: 'M' }, { Size: 'L' }]);
  });

  it('has no variants at all without options', () => {
    expect(variantMatrix([])).toEqual([]);
  });

  it('returns nothing rather than a partial matrix when an option has no values', () => {
    // A "variant" missing one of the product's options is not a variant the catalog can accept.
    expect(variantMatrix([size, { name: 'Colour', values: [] }])).toEqual([]);
    expect(variantMatrix([size, { name: 'Colour', values: ['  '] }])).toEqual([]);
  });

  it('ignores a half-typed option that has no name yet', () => {
    expect(variantMatrix([size, { name: '', values: ['Red'] }])).toHaveLength(3);
  });

  it('ignores blank values inside an option', () => {
    expect(variantMatrix([{ name: 'Size', values: ['S', '  ', 'M'] }])).toHaveLength(2);
  });

  it('handles three options', () => {
    expect(variantCount([size, colour, { name: 'Fit', values: ['Regular', 'Slim'] }])).toBe(12);
  });
});

describe('variantTitle', () => {
  it('joins values in the order the options were declared', () => {
    expect(variantTitle({ Colour: 'Red', Size: 'M' }, [size, colour])).toEqual('M / Red');
  });

  it('skips an option the combination does not carry', () => {
    expect(variantTitle({ Size: 'M' }, [size, colour])).toEqual('M');
  });
});

describe('suggestSku', () => {
  it('builds a readable starting point from the handle and values', () => {
    expect(suggestSku('classic-tee', { Size: 'M', Colour: 'Red' })).toEqual('CLASSICT-M-RED');
  });

  it('drops punctuation rather than emitting it into a SKU', () => {
    expect(suggestSku('tee', { Size: 'X / L' })).toEqual('TEE-XL');
  });

  it('copes with an empty handle', () => {
    expect(suggestSku('', { Size: 'M' })).toEqual('M');
  });
});
