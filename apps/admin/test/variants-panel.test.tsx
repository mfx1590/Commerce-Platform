import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantsPanel } from '@/app/(store)/[storeId]/catalog/[productId]/variants-panel';
import { ProductForm } from '@/app/(store)/[storeId]/catalog/product-form';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';

type Product = AdminComponents['Product'];
type Variant = AdminComponents['Variant'];

const createVariantAction = vi.hoisted(() => vi.fn());
const updateVariantAction = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/s1/catalog',
}));
vi.mock('@/app/actions/catalog', () => ({
  createVariantAction,
  updateVariantAction,
  createProductAction: vi.fn(),
}));

function variant(id: string, title: string, options: Record<string, string>): Variant {
  return {
    id,
    product_id: 'p1',
    sku: `SKU-${id}`,
    barcode: null,
    title,
    options,
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
  } as unknown as Variant;
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    handle: 'classic-tee',
    title: 'Classic Tee',
    subtitle: null,
    description: null,
    status: 'draft',
    category_id: null,
    brand_name: null,
    tags: [],
    attributes: {},
    seo: {},
    thumbnail_url: null,
    options: [
      { id: 'o1', name: 'Size', values: ['S', 'M'], position: 0 },
      { id: 'o2', name: 'Colour', values: ['Red', 'Blue'], position: 1 },
    ],
    variants: [],
    media: [],
    published_at: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as unknown as Product;
}

beforeEach(() => {
  vi.clearAllMocks();
  createVariantAction.mockResolvedValue({
    status: 'success',
    data: variant('v9', 'S / Red', { Size: 'S', Colour: 'Red' }),
  } satisfies ActionResult<Variant>);
  updateVariantAction.mockResolvedValue({
    status: 'success',
    data: variant('v1', 'S / Red', { Size: 'S', Colour: 'Red' }),
  } satisfies ActionResult<Variant>);
});

describe('variants are created deliberately, not as a side effect of saving options', () => {
  it('offers the four missing combinations rather than creating them', () => {
    render(<VariantsPanel storeId="s1" product={product()} />);

    expect(screen.getByText(/4 variants/)).toBeInTheDocument();
    expect(createVariantAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Create' })).toHaveLength(4);
  });

  it('creates one variant from its own row button', async () => {
    const user = userEvent.setup();
    render(<VariantsPanel storeId="s1" product={product()} />);

    await user.click(screen.getAllByRole('button', { name: 'Create' })[0] as HTMLElement);

    expect(createVariantAction).toHaveBeenCalledTimes(1);
    expect(createVariantAction).toHaveBeenCalledWith('s1', 'p1', {
      sku: 'CLASSICT-S-RED',
      title: 'S / Red',
      options: { Size: 'S', Colour: 'Red' },
    });
  });

  it('creates the whole gap only from the button that names the count', async () => {
    const user = userEvent.setup();
    render(<VariantsPanel storeId="s1" product={product()} />);

    await user.click(screen.getByRole('button', { name: 'Create all 4' }));
    expect(createVariantAction).toHaveBeenCalledTimes(4);
  });

  it('offers only the gap when some variants already exist', () => {
    const existing = [
      variant('v1', 'S / Red', { Size: 'S', Colour: 'Red' }),
      variant('v2', 'S / Blue', { Size: 'S', Colour: 'Blue' }),
    ];
    render(<VariantsPanel storeId="s1" product={product({ variants: existing })} />);

    expect(screen.getByText(/2 variants/)).toBeInTheDocument();
    expect(
      within(screen.getByRole('table', { name: 'Variants' })).getAllByRole('row'),
    ).toHaveLength(3);
  });

  it('says nothing is missing once every combination exists', () => {
    const existing = [
      variant('v1', 'S / Red', { Size: 'S', Colour: 'Red' }),
      variant('v2', 'S / Blue', { Size: 'S', Colour: 'Blue' }),
      variant('v3', 'M / Red', { Size: 'M', Colour: 'Red' }),
      variant('v4', 'M / Blue', { Size: 'M', Colour: 'Blue' }),
    ];
    render(<VariantsPanel storeId="s1" product={product({ variants: existing })} />);

    expect(screen.queryByRole('button', { name: /Create all/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });

  it('stops at the first refusal instead of pressing on', async () => {
    const user = userEvent.setup();
    createVariantAction.mockResolvedValueOnce({
      status: 'error',
      fieldErrors: {},
      formError: 'You need the store_staff relation on store:s1 to save this.',
    });

    render(<VariantsPanel storeId="s1" product={product()} />);
    await user.click(screen.getByRole('button', { name: 'Create all 4' }));

    expect(createVariantAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('store_staff');
  });
});

describe('editing a variant', () => {
  const existing = [variant('v1', 'S / Red', { Size: 'S', Colour: 'Red' })];

  it('shows the price formatted, in minor units', () => {
    render(<VariantsPanel storeId="s1" product={product({ variants: existing })} />);
    expect(screen.getByText(/19\.99/)).toBeInTheDocument();
  });

  it('saves the SKU and the price as an integer through updateVariant', async () => {
    const user = userEvent.setup();
    render(<VariantsPanel storeId="s1" product={product({ variants: existing })} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const sku = screen.getByLabelText('SKU');
    await user.clear(sku);
    await user.type(sku, 'TEE-S-RED');

    const price = screen.getByLabelText(/Price \(EUR\)/);
    await user.clear(price);
    await user.type(price, '24.50');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateVariantAction).toHaveBeenCalledWith('s1', 'v1', {
      sku: 'TEE-S-RED',
      title: 'S / Red',
      options: { Size: 'S', Colour: 'Red' },
      // 24.50 EUR is 2450 minor units — never 2449.9999999999995.
      prices: [{ currency: 'EUR', amount_minor: 2450 }],
    });
  });

  it('surfaces a refusal without leaving edit mode', async () => {
    const user = userEvent.setup();
    updateVariantAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'sku already exists',
    });

    render(<VariantsPanel storeId="s1" product={product({ variants: existing })} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('alert')).toHaveTextContent('sku already exists');
    expect(screen.getByLabelText('SKU')).toBeInTheDocument();
  });
});

describe('product media', () => {
  it('starts empty and explains what the first image is for', () => {
    render(
      <ProductForm
        action={async () => ({ status: 'error', fieldErrors: {}, formError: null })}
        categories={[]}
        submitLabel="Save"
        defaultValues={{ handle: 'classic-tee', title: 'Classic Tee', options: [], media: [] }}
      />,
    );
    expect(screen.getByText(/first one becomes the product thumbnail/)).toBeInTheDocument();
  });

  it('adds an image row with a URL and alt text', async () => {
    const user = userEvent.setup();
    render(
      <ProductForm
        action={async () => ({ status: 'error', fieldErrors: {}, formError: null })}
        categories={[]}
        submitLabel="Save"
        defaultValues={{ handle: 'classic-tee', title: 'Classic Tee', options: [], media: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add image' }));
    expect(screen.getByLabelText(/Image URL \(thumbnail\)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Alt text/)).toBeInTheDocument();
  });

  it('rejects something that is not a URL', async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({
      status: 'error' as const,
      fieldErrors: {},
      formError: null,
    }));
    render(
      <ProductForm
        action={action}
        categories={[]}
        submitLabel="Save"
        defaultValues={{ handle: 'classic-tee', title: 'Classic Tee', options: [], media: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add image' }));
    await user.type(screen.getByLabelText(/Image URL/), 'front.jpg');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(action).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a full URL/)).toBeInTheDocument();
  });
});
