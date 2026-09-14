import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishControls } from '@/app/(store)/[storeId]/catalog/[productId]/publish-controls';
import { ProductForm } from '@/app/(store)/[storeId]/catalog/product-form';
import type { AdminComponents } from '@/lib/api/admin-client';
import { toActionResult } from '@/lib/forms/action-result';
import type { ProductCreateValues } from '@/lib/forms/schemas';

type Product = AdminComponents['Product'];

const publishProductAction = vi.hoisted(() => vi.fn());
const archiveProductAction = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/s1/catalog',
}));
vi.mock('@/app/actions/catalog', () => ({
  publishProductAction,
  archiveProductAction,
  createProductAction: vi.fn(),
}));

const FORBIDDEN = {
  code: 'forbidden',
  message: 'requires store_staff on store:brand-a',
  details: { relation: 'store_staff', object: 'store:brand-a' },
};

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
    options: [],
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
});

describe('toActionResult separates a bad request from a refused principal', () => {
  it('carries a refusal for 403', () => {
    const result = toActionResult({ ok: false, status: 403, error: FORBIDDEN }, ['handle']);
    expect(result).toMatchObject({ status: 'error', refusal: { status: 403 } });
  });

  it('carries a refusal for 401', () => {
    const result = toActionResult(
      { ok: false, status: 401, error: { code: 'unauthorized', message: 'no token' } },
      [],
    );
    expect(result).toMatchObject({ status: 'error', refusal: { status: 401 } });
  });

  it('does not for a 400 — that names a field and belongs under the input', () => {
    const result = toActionResult(
      {
        ok: false,
        status: 400,
        error: {
          code: 'validation_error',
          message: 'handle must be kebab-case',
          details: { field: 'handle' },
        },
      },
      ['handle'],
    );
    expect(result).toMatchObject({ status: 'error', fieldErrors: { handle: expect.any(String) } });
    expect(result).not.toHaveProperty('refusal');
  });

  it('does not for a 409 or a 500', () => {
    for (const status of [409, 500]) {
      const result = toActionResult({ ok: false, status, error: { code: 'x', message: 'x' } }, [
        'handle',
      ]);
      expect(result).not.toHaveProperty('refusal');
    }
  });
});

describe('publishing is confirmed, because it emits product.published', () => {
  it('does not call the action on the first click', async () => {
    const user = userEvent.setup();
    render(<PublishControls storeId="s1" product={product()} />);

    await user.click(screen.getByRole('button', { name: 'Publish' }));

    expect(publishProductAction).not.toHaveBeenCalled();
    expect(screen.getByText(/becomes visible to shoppers/)).toBeInTheDocument();
  });

  it('publishes on confirmation and renders what the server returned', async () => {
    const user = userEvent.setup();
    publishProductAction.mockResolvedValue({
      status: 'success',
      data: product({ status: 'published', published_at: '2026-09-08T10:00:00Z' }),
    });
    render(<PublishControls storeId="s1" product={product()} />);

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(screen.getByRole('button', { name: 'Yes, publish' }));

    expect(publishProductAction).toHaveBeenCalledWith('s1', 'p1');
    expect(screen.getByText('published')).toBeInTheDocument();
    expect(screen.getByText(/2026-09-08 10:00/)).toBeInTheDocument();
  });

  it('cancelling leaves the product alone', async () => {
    const user = userEvent.setup();
    render(<PublishControls storeId="s1" product={product()} />);

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(publishProductAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
  });

  it('a refused publish shows the relation panel, not a line of red text', async () => {
    const user = userEvent.setup();
    publishProductAction.mockResolvedValue(
      toActionResult({ ok: false, status: 403, error: FORBIDDEN }, []),
    );
    render(<PublishControls storeId="s1" product={product()} />);

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(screen.getByRole('button', { name: 'Yes, publish' }));

    expect(
      screen.getByRole('heading', { name: /do not have access to this/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/You need the store_staff relation on store:brand-a/),
    ).toBeInTheDocument();
    // The product is untouched: still draft, still offering Publish.
    expect(screen.getByText('draft')).toBeInTheDocument();
  });

  it('a plain failure still reads as a message', async () => {
    const user = userEvent.setup();
    publishProductAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'The catalog service is unavailable.',
    });
    render(<PublishControls storeId="s1" product={product()} />);

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(screen.getByRole('button', { name: 'Yes, publish' }));

    expect(screen.getByRole('alert')).toHaveTextContent('The catalog service is unavailable.');
    expect(screen.queryByRole('heading', { name: /do not have access/i })).toBeNull();
  });

  it('archive is still confirmed separately', async () => {
    const user = userEvent.setup();
    archiveProductAction.mockResolvedValue({ status: 'success', data: null });
    render(<PublishControls storeId="s1" product={product()} />);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(archiveProductAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, archive' }));
    expect(archiveProductAction).toHaveBeenCalledWith('s1', 'p1');
  });

  it('an archived product offers neither action', () => {
    render(<PublishControls storeId="s1" product={product({ status: 'archived' })} />);
    // Archiving is terminal here: neither control does anything, and both say why by their label.
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archived' })).toBeDisabled();
  });

  it('an already-published product cannot be published again', () => {
    render(<PublishControls storeId="s1" product={product({ status: 'published' })} />);
    expect(screen.getByRole('button', { name: 'Published' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
  });
});

describe('media rows can be reordered', () => {
  const withMedia = {
    handle: 'classic-tee',
    title: 'Classic Tee',
    options: [],
    media: [
      { url: 'https://x/a.jpg', alt: null },
      { url: 'https://x/b.jpg', alt: null },
      { url: 'https://x/c.jpg', alt: null },
    ],
  };

  function renderForm() {
    return render(
      <ProductForm
        action={async () => ({ status: 'error', fieldErrors: {}, formError: null })}
        categories={[]}
        submitLabel="Save"
        defaultValues={withMedia}
      />,
    );
  }

  function urls(): string[] {
    return screen.getAllByLabelText(/Image URL/).map((input) => (input as HTMLInputElement).value);
  }

  it('labels the first row as the thumbnail', () => {
    renderForm();
    expect(screen.getByLabelText(/Image URL \(thumbnail\)/)).toHaveValue('https://x/a.jpg');
  });

  it('moves a row down', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Move image 1 down' }));
    expect(urls()).toEqual(['https://x/b.jpg', 'https://x/a.jpg', 'https://x/c.jpg']);
  });

  it('moves a row up, which is how a later image becomes the thumbnail', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Move image 3 up' }));
    expect(urls()).toEqual(['https://x/a.jpg', 'https://x/c.jpg', 'https://x/b.jpg']);
  });

  it('cannot move the first row up or the last row down', () => {
    renderForm();
    expect(screen.getByRole('button', { name: 'Move image 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move image 3 down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move image 1 down' })).toBeEnabled();
  });

  it('removing a row keeps the rest in order', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Remove image 2' }));
    expect(urls()).toEqual(['https://x/a.jpg', 'https://x/c.jpg']);
  });
});

describe('a refused save on the product form', () => {
  it('renders the panel instead of a form-level message', async () => {
    const user = userEvent.setup();
    render(
      <ProductForm
        action={async () =>
          toActionResult({ ok: false, status: 403, error: FORBIDDEN }, ['handle'])
        }
        categories={[]}
        submitLabel="Save"
        defaultValues={{ handle: 'classic-tee', title: 'Classic Tee', options: [], media: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The action runs inside a transition, so the panel arrives after the click resolves.
    const panel = await screen.findByRole('heading', { name: /do not have access to this/i });
    expect(panel).toBeInTheDocument();
    expect(
      within(panel.closest('div') as HTMLElement).getByText(/store_staff/),
    ).toBeInTheDocument();
  });
});

describe('the form can actually be submitted', () => {
  const valid = { handle: 'classic-tee', title: 'Classic Tee', options: [], media: [] };
  // A real uuid: the contract types `category_id` as one, so the schema rejects anything else —
  // and now says so under the Category field rather than failing silently.
  const CATEGORY = {
    id: '00000000-0000-4000-8000-0000000000c1',
    handle: 'tops',
    name: 'Tops',
    parent_id: null,
    position: 0,
    is_active: true,
  } as AdminComponents['Category'];

  function renderWith(action: ReturnType<typeof vi.fn>) {
    render(
      <ProductForm
        action={action}
        categories={[CATEGORY]}
        submitLabel="Save"
        defaultValues={valid}
      />,
    );
  }

  it('saves with no category chosen, sending null rather than an empty string', async () => {
    // Regression: the Category select's "none" option is `value=""`, which is neither a uuid nor
    // null, so the schema rejected every submit — and because the field had no error slot, the
    // form simply did nothing when Save was pressed.
    const user = userEvent.setup();
    // Typed parameter, so `mock.calls[0][0]` is the submitted values rather than `never`.
    const action = vi.fn(async (_values: ProductCreateValues) => ({
      status: 'success' as const,
      data: product(),
    }));
    renderWith(action);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]?.[0]).toMatchObject({ category_id: null });
  });

  it('saves with a category chosen, sending its id', async () => {
    const user = userEvent.setup();
    // Typed parameter, so `mock.calls[0][0]` is the submitted values rather than `never`.
    const action = vi.fn(async (_values: ProductCreateValues) => ({
      status: 'success' as const,
      data: product(),
    }));
    renderWith(action);

    await user.selectOptions(screen.getByLabelText(/Category/), CATEGORY.id);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(action.mock.calls[0]?.[0]).toMatchObject({ category_id: CATEGORY.id });
  });

  it('still refuses a genuinely invalid handle, and says so under the input', async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    renderWith(action);

    await user.clear(screen.getByLabelText(/Handle/));
    await user.type(screen.getByLabelText(/Handle/), 'Classic Tee');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(action).not.toHaveBeenCalled();
    expect(screen.getByText(/lower-case letters, numbers and single hyphens/)).toBeInTheDocument();
  });
});
