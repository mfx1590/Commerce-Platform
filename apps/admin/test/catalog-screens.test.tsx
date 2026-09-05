import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductForm } from '@/app/(store)/[storeId]/catalog/product-form';
import {
  CategoriesPanel,
  buildTree,
} from '@/app/(store)/[storeId]/catalog/categories/categories-panel';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';

type Product = AdminComponents['Product'];
type Category = AdminComponents['Category'];

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, back: vi.fn() }),
  usePathname: () => '/store-1/catalog',
}));
vi.mock('@/app/actions/catalog', () => ({
  createProductAction: vi.fn(),
  createCategoryAction: vi.fn(),
}));

const noop = async (): Promise<ActionResult<Product>> => ({
  status: 'error',
  fieldErrors: {},
  formError: null,
});

function renderProductForm() {
  return render(
    <ProductForm
      action={noop}
      categories={[]}
      submitLabel="Create product"
      defaultValues={{ handle: 'classic-tee', title: 'Classic Tee', options: [] }}
    />,
  );
}

async function addOption(user: ReturnType<typeof userEvent.setup>, name: string, values: string) {
  await user.click(screen.getByRole('button', { name: 'Add option' }));
  const nameInputs = screen.getAllByLabelText(/^Name/);
  const valueInputs = screen.getAllByLabelText(/^Values/);
  await user.type(nameInputs[nameInputs.length - 1] as HTMLElement, name);
  await user.type(valueInputs[valueInputs.length - 1] as HTMLElement, values);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('product form: options build the variant matrix', () => {
  it('says a product with no options has a single variant', () => {
    renderProductForm();
    expect(
      screen.getByText(/No options, so this product will have a single default variant/),
    ).toBeInTheDocument();
  });

  it('expands one option into one variant per value', async () => {
    const user = userEvent.setup();
    renderProductForm();
    await addOption(user, 'Size', 'S, M, L');

    const table = screen.getByRole('table', { name: /Variants this product will have/ });
    // Three rows plus the header.
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('S')).toBeInTheDocument();
  });

  it('crosses two options rather than listing them side by side', async () => {
    const user = userEvent.setup();
    renderProductForm();
    await addOption(user, 'Size', 'S, M, L');
    await addOption(user, 'Colour', 'Red, Blue');

    const table = screen.getByRole('table', { name: /Variants this product will have/ });
    expect(within(table).getAllByRole('row')).toHaveLength(7); // 6 variants + header
    expect(within(table).getByText('S / Red')).toBeInTheDocument();
    expect(within(table).getByText('L / Blue')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Variants · 6/ })).toBeInTheDocument();
  });

  it('suggests a SKU per variant from the handle', async () => {
    const user = userEvent.setup();
    renderProductForm();
    await addOption(user, 'Size', 'M');

    expect(screen.getByText('CLASSICT-M')).toBeInTheDocument();
  });

  it('waits for values before claiming any variants', async () => {
    const user = userEvent.setup();
    renderProductForm();
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    await user.type(screen.getByLabelText(/^Name/), 'Size');

    expect(screen.getByText(/Give every option at least one value/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /Variants this product/ })).toBeNull();
  });

  it('shrinks the matrix when an option is removed', async () => {
    const user = userEvent.setup();
    renderProductForm();
    await addOption(user, 'Size', 'S, M');
    await addOption(user, 'Colour', 'Red, Blue');
    expect(screen.getByRole('heading', { name: /Variants · 4/ })).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1] as HTMLElement);
    expect(screen.getByRole('heading', { name: /Variants · 2/ })).toBeInTheDocument();
  });
});

const category = (
  id: string,
  name: string,
  handle: string,
  parentId: string | null,
  position = 0,
): Category => ({ id, name, handle, parent_id: parentId, position, is_active: true });

describe('category tree', () => {
  it('nests children under their parent', () => {
    const tree = buildTree([
      category('1', 'Tops', 'tops', null),
      category('2', 'T-shirts', 't-shirts', '1'),
      category('3', 'Bottoms', 'bottoms', null, 1),
    ]);

    expect(tree.map((node) => node.category.name)).toEqual(['Tops', 'Bottoms']);
    expect(tree[0]?.children.map((node) => node.category.name)).toEqual(['T-shirts']);
  });

  it('orders siblings by position, then name', () => {
    const tree = buildTree([
      category('1', 'Bags', 'bags', null, 2),
      category('2', 'Caps', 'caps', null, 1),
      category('3', 'Accessories', 'accessories', null, 1),
    ]);
    expect(tree.map((node) => node.category.name)).toEqual(['Accessories', 'Caps', 'Bags']);
  });

  it('shows an orphan at the root rather than dropping it', () => {
    // Hiding catalog rows would be worse than showing one at the wrong depth.
    const tree = buildTree([category('2', 'T-shirts', 't-shirts', 'missing-parent')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.category.name).toEqual('T-shirts');
  });

  it('renders the tree with the child inside its parent', () => {
    render(
      <CategoriesPanel
        storeId="store-1"
        categories={[
          category('1', 'Tops', 'tops', null),
          category('2', 'T-shirts', 't-shirts', '1'),
        ]}
      />,
    );
    // "Tops" also appears as a <option> in the parent select, so scope to the tree itself.
    const tree = screen.getAllByRole('list')[0] as HTMLElement;
    const tops = within(tree).getByText('Tops').closest('li');
    expect(tops).not.toBeNull();
    expect(within(tops as HTMLElement).getByText('T-shirts')).toBeInTheDocument();
  });

  it('offers the parent select and a top-level option', () => {
    render(
      <CategoriesPanel storeId="store-1" categories={[category('1', 'Tops', 'tops', null)]} />,
    );
    const options = within(screen.getByRole('combobox', { name: /Parent/ })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['— top level —', 'Tops']);
  });
});
