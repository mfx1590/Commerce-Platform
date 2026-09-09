// Pure tests for the feed writers and the channel required-field rules (#146). No database.
import { describe, expect, it } from 'vitest';
import {
  blocksPublication,
  formatPrice,
  publishableItems,
  renderGoogleFeed,
  renderMetaFeed,
  validateItem,
  validateItems,
  type FeedItem,
} from './index';

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: 'TEE-M-RED',
  product_id: '30000000-0000-4000-8000-000000000201',
  variant_id: '30000000-0000-4000-8000-000000000301',
  sku: 'TEE-M-RED',
  title: 'Classic Tee - M / Red',
  description: 'Heavyweight cotton tee.',
  link: 'https://shop.brand-a.local/products/classic-tee?variant=30000000-0000-4000-8000-000000000301',
  image_link: 'https://cdn.example/classic-tee.jpg',
  gtin: '00012345600012',
  brand: 'Brand A',
  availability: 'in_stock',
  price: { amount_minor: 1999, currency: 'EUR' },
  sale_price: null,
  item_group_id: 'classic-tee',
  errors: [],
  ...over,
});

describe('formatPrice', () => {
  it('writes major units with the currency, honouring the ISO exponent', () => {
    expect(formatPrice(1999, 'EUR')).toBe('19.99 EUR');
    expect(formatPrice(5, 'EUR')).toBe('0.05 EUR');
    expect(formatPrice(0, 'EUR')).toBe('0.00 EUR');
    expect(formatPrice(250000, 'GBP')).toBe('2500.00 GBP');
    // Zero-decimal and three-decimal currencies are not a hypothetical: a feed quoting "1999 JPY" as 19.99
    // would be off by two orders of magnitude.
    expect(formatPrice(1999, 'JPY')).toBe('1999 JPY');
    expect(formatPrice(1999, 'KWD')).toBe('1.999 KWD');
    expect(formatPrice(1999, 'eur')).toBe('19.99 EUR');
  });
});

describe('validation', () => {
  it('names every missing required field per channel', () => {
    expect(validateItem(item(), 'google_merchant')).toEqual([]);
    expect(validateItem(item({ image_link: null, description: '' }), 'google_merchant')).toEqual([
      'missing_description',
      'missing_image_link',
    ]);
    // Meta additionally insists on a brand; Google does not (it warns only for GTIN).
    expect(validateItem(item({ brand: null }), 'meta')).toEqual(['missing_brand']);
    expect(validateItem(item({ brand: null }), 'google_merchant')).toEqual([]);
  });

  it('treats a missing GTIN as an advisory that does not keep the row out of the file', () => {
    const codes = validateItem(item({ gtin: null }), 'google_merchant');
    expect(codes).toEqual(['missing_gtin']);
    expect(blocksPublication(codes)).toBe(false);
    expect(blocksPublication(['missing_gtin', 'missing_title'])).toBe(true);
    // Meta does not ask for one.
    expect(validateItem(item({ gtin: null }), 'meta')).toEqual([]);
  });

  it('reports a bad item instead of dropping it silently (#146)', () => {
    const items = [item(), item({ id: 'BAD', sku: 'BAD', title: '' })];
    const errors = validateItems(items, 'google_merchant');

    // The item keeps its own error codes and is still returned to the admin …
    expect(items[1]!.errors).toEqual(['missing_title']);
    expect(errors).toEqual([
      {
        code: 'missing_title',
        message: 'title is required',
        product_id: items[1]!.product_id,
      },
    ]);
    // … and only the good one reaches the file.
    expect(publishableItems(items).map((i) => i.id)).toEqual(['TEE-M-RED']);
  });
});

describe('Google Merchant RSS', () => {
  it('writes the g: namespace, condition and a sale price', () => {
    const xml = renderGoogleFeed(
      [
        item({
          sale_price: { amount_minor: 1499, currency: 'EUR' },
          price: { amount_minor: 1999, currency: 'EUR' },
        }),
      ],
      { name: 'Google Shopping NL', link: 'https://shop.brand-a.local' },
    );
    expect(xml).toContain('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
    expect(xml).toContain('<g:id>TEE-M-RED</g:id>');
    expect(xml).toContain('<g:availability>in_stock</g:availability>');
    expect(xml).toContain('<g:condition>new</g:condition>');
    expect(xml).toContain('<g:price>19.99 EUR</g:price>');
    expect(xml).toContain('<g:sale_price>14.99 EUR</g:sale_price>');
    expect(xml).toContain('<g:item_group_id>classic-tee</g:item_group_id>');
  });

  it('omits empty elements rather than writing empty tags, and escapes XML', () => {
    const xml = renderGoogleFeed([item({ gtin: null, title: 'Tee "M" & <Red>' })], {
      name: 'Feed & co',
      link: null,
    });
    expect(xml).not.toContain('<g:gtin>');
    expect(xml).toContain('<g:title>Tee &quot;M&quot; &amp; &lt;Red&gt;</g:title>');
    expect(xml).toContain('<title>Feed &amp; co</title>');
  });

  it('is deterministic — the same items render byte-identical output', () => {
    const feed = { name: 'Google Shopping NL', link: 'https://shop.brand-a.local' };
    expect(renderGoogleFeed([item()], feed)).toBe(renderGoogleFeed([item()], feed));
    // A timestamp in the file would break publish idempotency, so there must not be one.
    expect(renderGoogleFeed([item()], feed)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('Meta CSV', () => {
  it('writes the header, the constant condition and CRLF rows', () => {
    const csv = renderMetaFeed([item()]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'id,title,description,availability,condition,price,link,image_link,brand,sale_price,item_group_id,gtin',
    );
    expect(lines[1]).toContain('in stock');
    expect(lines[1]).toContain('new');
    expect(lines[1]).toContain('19.99 EUR');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    const csv = renderMetaFeed([
      item({ title: 'Tee, large', description: 'He said "hi"\nthen left' }),
    ]);
    expect(csv).toContain('"Tee, large"');
    expect(csv).toContain('"He said ""hi""');
  });

  it('maps availability to Meta wording and leaves an absent sale price empty', () => {
    expect(renderMetaFeed([item({ availability: 'out_of_stock' })])).toContain('out of stock');
    expect(renderMetaFeed([item({ availability: 'backorder' })])).toContain('available for order');
    const row = renderMetaFeed([item()]).split('\r\n')[1]!;
    expect(row.split(',')[9]).toBe('');
  });

  it('is deterministic', () => {
    expect(renderMetaFeed([item()])).toBe(renderMetaFeed([item()]));
  });
});
