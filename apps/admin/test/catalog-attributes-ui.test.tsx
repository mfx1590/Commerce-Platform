/**
 * Catalog attributes in the browser (#870 wave 1 item 5, PR A): the variant editor (shipping,
 * customs, compare-at; formats checked as typed; the compare-at warning that does not block) and
 * the product form's tags, SEO and attributes (merged, nothing lost).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantsPanel } from '@/app/(store)/[storeId]/catalog/[productId]/variants-panel';
import { ProductForm } from '@/app/(store)/[storeId]/catalog/product-form';
import type { AdminComponents } from '@/lib/api/admin-client';

type Product = AdminComponents['Product'];
type Variant = AdminComponents['Variant'];

const updateVariantAction = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/s1/catalog',
}));
vi.mock('@/app/actions/catalog', () => ({
  createVariantAction: vi.fn(),
  updateVariantAction,
  createProductAction: vi.fn(),
}));

const variant = (overrides: Partial<Variant> = {}): Variant =>
  ({
    id: 'v1',
    product_id: 'p1',
    sku: 'TOWEL-1',
    barcode: null,
    title: 'One size',
    options: {},
    manage_inventory: true,
    allow_backorder: false,
    weight_g: null,
    dimensions_mm: null,
    hs_code: null,
    origin_country: null,
    position: 0,
    prices: [
      {
        price_list_id: 'pl1',
        currency: 'EUR',
        amount_minor: 1999,
        compare_at_minor: null,
        min_quantity: 1,
      },
    ],
    inventory: [],
    ...overrides,
  }) as Variant;

const product = (variants: Variant[]): Product =>
  ({
    id: 'p1',
    handle: 'linen-tea-towel',
    title: 'Linen tea towel',
    subtitle: null,
    description: null,
    status: 'draft',
    category_id: null,
    brand_name: null,
    tags: [],
    attributes: {},
    seo: {},
    thumbnail_url: null,
    options: [],
    variants,
    media: [],
    published_at: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  }) as unknown as Product;

beforeEach(() => {
  vi.clearAllMocks();
  updateVariantAction.mockResolvedValue({ status: 'success', data: variant() });
});

describe('the variant list says what is missing', () => {
  it('per variant, in words; complete when nothing is', () => {
    render(
      <VariantsPanel
        storeId="s1"
        product={product([
          variant(),
          variant({
            id: 'v2',
            sku: 'TOWEL-2',
            barcode: '4006381333931',
            weight_g: 120,
            dimensions_mm: { l: 400, w: 300, h: 20 },
            hs_code: '630260',
            origin_country: 'PT',
          }),
        ])}
      />,
    );
    expect(screen.getByRole('row', { name: 'Variant TOWEL-1' })).toHaveTextContent(
      'missing: barcode, weight, dimensions, HS code, origin',
    );
    expect(screen.getByRole('row', { name: 'Variant TOWEL-2' })).toHaveTextContent('complete');
    expect(screen.getByText(/A variant cannot be deleted here/)).toBeInTheDocument();
  });
});

describe('the variant editor', () => {
  async function open() {
    const user = userEvent.setup();
    render(
      <VariantsPanel storeId="s1" product={product([variant()])} defaultPriceListIds={['pl1']} />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit TOWEL-1' }));
    return { user, form: screen.getByRole('form', { name: 'Edit variant TOWEL-1' }) };
  }

  it('sends every attribute, normalised: HS dots stripped, country upper case, whole mm and g', async () => {
    const { user, form } = await open();
    const f = within(form);
    // Each value arrives in one paste, not keystroke by keystroke: what is sent is the point here,
    // and ~50 re-renders of the panel ran past the 5 s timeout under a loaded full run (#948).
    const fill = async (label: string, text: string) => {
      await user.click(f.getByLabelText(label));
      await user.paste(text);
    };
    await fill('Barcode (EAN / UPC / GTIN)', ' 4006381333931 ');
    await user.click(f.getByLabelText('Sell when out of stock (backorder)'));
    await fill('Weight (g)', '120');
    await fill('Length (mm)', '400');
    await fill('Width (mm)', '300');
    await fill('Height (mm)', '20');
    await fill('HS code', '6302.60.00');
    await fill('Country of origin', 'pt');
    await fill('Compare-at (EUR)', '24.99');
    await user.click(f.getByRole('button', { name: 'Save' }));
    expect(updateVariantAction).toHaveBeenCalledWith('s1', 'v1', {
      sku: 'TOWEL-1',
      title: 'One size',
      options: {},
      barcode: '4006381333931',
      manage_inventory: true,
      allow_backorder: true,
      weight_g: 120,
      dimensions_mm: { l: 400, w: 300, h: 20 },
      hs_code: '63026000',
      origin_country: 'PT',
      prices: [{ currency: 'EUR', amount_minor: 1999, compare_at_minor: 2499 }],
    });
  });

  it('wrong formats are said under their field and Save is held', async () => {
    const { user, form } = await open();
    const f = within(form);
    await user.type(f.getByLabelText('Weight (g)'), '1.5');
    await user.type(f.getByLabelText('HS code'), '63026');
    await user.type(f.getByLabelText('Country of origin'), 'P1');
    await user.type(f.getByLabelText('Length (mm)'), '400');
    expect(f.getByText('Whole grams, 0 or more.')).toBeInTheDocument();
    expect(f.getByText('An HS code is 6, 8 or 10 digits.')).toBeInTheDocument();
    expect(f.getByText('Use the two-letter ISO country code, e.g. JP.')).toBeInTheDocument();
    expect(f.getByText('Give all three sides, or none.')).toBeInTheDocument();
    expect(f.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(updateVariantAction).not.toHaveBeenCalled();
  });

  it('a compare-at that shows no saving is a warning, and Save still works', async () => {
    const { user, form } = await open();
    const f = within(form);
    await user.type(f.getByLabelText('Compare-at (EUR)'), '19.99');
    expect(f.getByRole('note')).toHaveTextContent(
      'The compare-at price in EUR is not above the price',
    );
    await user.click(f.getByRole('button', { name: 'Save' }));
    expect(updateVariantAction).toHaveBeenCalledTimes(1);
  });
});

describe('the product form: tags, SEO and attributes', () => {
  it('saves them merged with what the product already had; a non-text attribute is kept', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'success', data: { id: 'p1' } });
    render(
      <ProductForm
        action={action}
        categories={[]}
        submitLabel="Save product"
        defaultValues={{
          handle: 'linen-tea-towel',
          title: 'Linen tea towel',
          tags: ['linen'],
          seo: { title: 'Old title', og_image: 'https://cdn.example/og.jpg' },
          attributes: { material: 'linen', colours: ['red', 'blue'] },
          options: [],
          media: [],
        }}
      />,
    );
    const tags = screen.getByLabelText('Tags, separated by commas');
    await user.clear(tags);
    await user.type(tags, 'linen, kitchen, linen');
    expect(
      within(screen.getByRole('list', { name: 'Tags' })).getAllByRole('listitem'),
    ).toHaveLength(2);

    const seo = screen.getByRole('region', { name: 'Search engines' });
    const title = within(seo).getByLabelText('SEO title');
    await user.clear(title);
    await user.type(title, 'Linen tea towel — woven in Portugal');
    await user.type(within(seo).getByLabelText('SEO description'), 'Heavy linen, washed twice.');

    const attributes = screen.getByRole('region', { name: 'Attributes' });
    expect(attributes).toHaveTextContent(
      'Kept as they are (not text, so not editable here): colours.',
    );
    await user.click(within(attributes).getByRole('button', { name: 'Add attribute' }));
    await user.type(within(attributes).getByLabelText('Attribute 2 name'), 'care');
    await user.type(within(attributes).getByLabelText('Attribute 2 value'), '40°C');

    await user.click(screen.getByRole('button', { name: 'Save product' }));
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['linen', 'kitchen'],
        seo: {
          title: 'Linen tea towel — woven in Portugal',
          description: 'Heavy linen, washed twice.',
          og_image: 'https://cdn.example/og.jpg',
        },
        attributes: { colours: ['red', 'blue'], material: 'linen', care: '40°C' },
      }),
    );
  });

  it('a long SEO title is warned about; a bad canonical is said', async () => {
    const user = userEvent.setup();
    render(
      <ProductForm
        action={vi.fn()}
        categories={[]}
        submitLabel="Save product"
        defaultValues={{ handle: 'x', title: 'X', options: [], media: [] }}
      />,
    );
    const seo = screen.getByRole('region', { name: 'Search engines' });
    await user.type(within(seo).getByLabelText('SEO title'), 'x'.repeat(61));
    expect(seo).toHaveTextContent('61 / 60 characters — search engines usually cut the rest.');
    await user.type(within(seo).getByLabelText('Canonical URL (optional)'), 'http://elsewhere');
    expect(within(seo).getByRole('alert')).toHaveTextContent(
      'Use an https:// address or a path starting with /.',
    );
  });
});

describe('#947 review (MONEY): only the default price at quantity 1 is edited', () => {
  const mixed = () =>
    variant({
      prices: [
        {
          price_list_id: 'pl-default',
          currency: 'EUR',
          amount_minor: 1999,
          compare_at_minor: null,
          min_quantity: 1,
        },
        {
          price_list_id: 'pl-default',
          currency: 'EUR',
          amount_minor: 1799,
          compare_at_minor: null,
          min_quantity: 10,
        },
        {
          price_list_id: 'pl-sale',
          currency: 'EUR',
          amount_minor: 1499,
          compare_at_minor: 1999,
          min_quantity: 1,
        },
      ],
    });
  const names = { 'pl-default': 'Default EUR', 'pl-sale': 'Summer sale' };

  async function open(defaultIds: string[] | null = ['pl-default']) {
    const user = userEvent.setup();
    render(
      <VariantsPanel
        storeId="s1"
        product={product([mixed()])}
        defaultPriceListIds={defaultIds}
        priceListNames={names}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit TOWEL-1' }));
    return { user, form: within(screen.getByRole('form', { name: 'Edit variant TOWEL-1' })) };
  }

  it('one editable EUR price (the default, qty 1); the tier and the sale price are read-only with their list', async () => {
    const { form } = await open();
    expect(form.getAllByLabelText(/^Price \(EUR\)/)).toHaveLength(1);
    expect(form.getByLabelText(/^Price \(EUR\)/)).toHaveValue('19.99');
    const others = form.getByRole('list', { name: 'Other prices' });
    expect(others).toHaveTextContent('€17.99 — Default EUR, from 10 units');
    expect(others).toHaveTextContent('€14.99 (compare-at €19.99) — Summer sale');
  });

  it('a barcode-only save sends no prices at all', async () => {
    const { user, form } = await open();
    await user.type(form.getByLabelText('Barcode (EAN / UPC / GTIN)'), '4006381333931');
    await user.click(form.getByRole('button', { name: 'Save' }));
    const body = updateVariantAction.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body).toMatchObject({ barcode: '4006381333931' });
    expect(body).not.toHaveProperty('prices');
  });

  it('changing the default price sends only the default row, never the tier or the sale price', async () => {
    const { user, form } = await open();
    const price = form.getByLabelText(/^Price \(EUR\)/);
    await user.clear(price);
    await user.type(price, '21.00');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(updateVariantAction.mock.calls[0]?.[2]).toMatchObject({
      prices: [{ currency: 'EUR', amount_minor: 2100, compare_at_minor: null }],
    });
  });

  it('a cleared price is said not to be removed, and nothing price-related is sent', async () => {
    const { user, form } = await open();
    await user.clear(form.getByLabelText(/^Price \(EUR\)/));
    expect(form.getByText(/Clearing the price in EUR does not remove it/)).toBeInTheDocument();
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(updateVariantAction.mock.calls[0]?.[2]).not.toHaveProperty('prices');
  });

  it('when the price lists cannot be read, no price is editable and that is said', async () => {
    const { user, form } = await open(null);
    expect(form.queryByLabelText(/^Price \(EUR\)/)).not.toBeInTheDocument();
    expect(
      form.getByText(/The price lists could not be read, so no price can be edited here/),
    ).toBeInTheDocument();
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(updateVariantAction.mock.calls[0]?.[2]).not.toHaveProperty('prices');
  });
});

describe('#947 review: a legacy value never blocks another save', () => {
  it('an old 4-digit HS code and a two-sided parcel, unchanged: not checked, not sent', async () => {
    const user = userEvent.setup();
    render(
      <VariantsPanel
        storeId="s1"
        product={product([variant({ hs_code: '6302', dimensions_mm: { l: 400, w: 300 } })])}
        defaultPriceListIds={['pl1']}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit TOWEL-1' }));
    const form = within(screen.getByRole('form', { name: 'Edit variant TOWEL-1' }));
    await user.type(form.getByLabelText('Barcode (EAN / UPC / GTIN)'), '1');
    expect(form.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(form.getByRole('button', { name: 'Save' }));
    const body = updateVariantAction.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('hs_code');
    expect(body).not.toHaveProperty('dimensions_mm');
  });
});
