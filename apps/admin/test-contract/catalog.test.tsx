/**
 * The catalog editor against the real spec, not a stubbed fetch.
 *
 * The unit tests prove each piece in isolation with a hand-written fixture. This proves the pieces
 * agree with the contract: the typed wrappers in `src/lib/api/admin.ts` really do reach the paths
 * `admin-api.yaml` documents, the server actions really do turn its documented `400` and `409`
 * examples into the field errors the form renders, and a `403` really does come out as the panel
 * naming the relation. If an example in the spec stopped carrying `details.field`, the unit tests
 * would still pass — this would not.
 *
 * Prism is spawned here, so `pnpm --filter @platform/admin test:contract` needs nothing running.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

/**
 * Its own port, and `ADMIN_API_URL` is set **before** the modules under test are imported — the app
 * resolves the base URL once at module scope, so importing first would pin this suite to whatever
 * the config set for the other contract file.
 */
const BASE = 'http://127.0.0.1:4212';
process.env['ADMIN_API_URL'] = BASE;
process.env['MOCK_ADMIN_API_URL'] = BASE;

// The wrappers are `server-only` and read the session from `next/headers`; neither exists here, and
// neither is what this suite is testing. The token value is irrelevant — Prism accepts any bearer.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'contract-test' }),
  requireSession: async () => ({ accessToken: 'contract-test' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const api = await import('@/lib/api/admin');
const { toActionResult } = await import('@/lib/forms/action-result');
const { fieldNames, productCreateSchema } = await import('@/lib/forms/schemas');
const { ProductForm } = await import('@/app/(store)/[storeId]/catalog/product-form');
const { PublishControls } =
  await import('@/app/(store)/[storeId]/catalog/[productId]/publish-controls');
const { VariantsPanel } =
  await import('@/app/(store)/[storeId]/catalog/[productId]/variants-panel');
const { CategoriesPanel } =
  await import('@/app/(store)/[storeId]/catalog/categories/categories-panel');
const { ProductsTable } = await import('@/app/(store)/[storeId]/catalog/products-table');
const { PRODUCTS_TABLE_DEFAULTS, PRODUCT_FILTER_KEYS } =
  await import('@/app/(store)/[storeId]/catalog/products-table.config');
const { parseTableQuery, toContractQuery } = await import('@/lib/table/query-state');

// `refresh` is observable: after a 2xx the screens re-read the product through it rather than
// guessing the new state, so "was it called" is the assertion for a mutation that rendered nothing.
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/catalog',
}));

let prism: PrismHandle;

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

beforeEach(() => {
  refresh.mockClear();
});

const NEW_PRODUCT = { handle: 'classic-tee', title: 'Classic Tee', options: [], media: [] };

describe('the wrappers reach the paths the spec documents', () => {
  it('lists products', async () => {
    const result = await api.listProducts(SEED_STORE_ID, { page: 1, limit: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data).toMatchObject({ page: expect.any(Number), total: expect.any(Number) });
    expect(Array.isArray(result.data.items)).toBe(true);
  });

  it('reads one product, with the fields the editor renders', async () => {
    const list = await api.listProducts(SEED_STORE_ID, { page: 1, limit: 1 });
    if (!list.ok) throw new Error('expected success');
    const first = list.data.items[0];
    expect(first).toBeDefined();

    const result = await api.getProduct(SEED_STORE_ID, first!.id);
    if (!result.ok) throw new Error('expected success');
    // Exactly what `ProductForm` and `VariantsPanel` read back out.
    expect(result.data).toMatchObject({
      handle: expect.any(String),
      title: expect.any(String),
      status: expect.any(String),
    });
    expect(Array.isArray(result.data.options)).toBe(true);
    expect(Array.isArray(result.data.variants)).toBe(true);
    expect(Array.isArray(result.data.media)).toBe(true);
  });

  it('lists categories, which is what the category picker offers', async () => {
    const result = await api.listCategories(SEED_STORE_ID);
    if (!result.ok) throw new Error('expected success');
    for (const category of result.data.items) {
      // The picker sends this straight back as `category_id`, and the schema demands a uuid.
      expect(category.id).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('publishes, and the response carries the status the screen renders', async () => {
    const result = await api.publishProduct(SEED_STORE_ID, SEED_STORE_ID);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.status).toEqual('published');
    expect(result.data).toHaveProperty('published_at');
  });

  it('creates a variant', async () => {
    const result = await api.createVariant(SEED_STORE_ID, SEED_STORE_ID, {
      sku: 'TEE-M-RED',
      title: 'M / Red',
      options: { Size: 'M', Colour: 'Red' },
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.data).toMatchObject({ sku: expect.any(String), title: expect.any(String) });
  });

  it('archives with a 204, which has no body to render', async () => {
    const result = await api.archiveProduct(SEED_STORE_ID, SEED_STORE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.status).toBe(204);
  });
});

describe("the spec's own error examples reach the right control", () => {
  const PRODUCTS = `/admin/stores/${SEED_STORE_ID}/products`;
  const KNOWN = fieldNames(productCreateSchema);

  /**
   * The wrappers do not take headers — a `Prefer` parameter on a production server action would be
   * a test-only door into shipped code. `adminCall` is the exported seam underneath them, so this
   * drives the same transport and the same mapping without changing a signature.
   */
  const asking = <K extends 'createProduct' | 'updateProduct' | 'publishProduct'>(
    op: K,
    code: number,
    extra: { path: string; method: 'POST' | 'PATCH'; body?: unknown },
  ) =>
    api.adminCall<K>({
      path: extra.path,
      method: extra.method,
      ...(extra.body === undefined ? {} : { body: extra.body }),
      headers: preferring(code),
    });

  it("400 puts the spec's own message under the Handle input", async () => {
    const result = await asking('createProduct', 400, {
      path: PRODUCTS,
      method: 'POST',
      body: NEW_PRODUCT,
    });
    const mapped = toActionResult(result, KNOWN);

    expect(mapped.status).toEqual('error');
    if (mapped.status !== 'error') throw new Error('expected a refusal');
    // `admin-api.yaml`'s BadRequest example names `handle` — that is what lets the form put an
    // error it has never seen before under the right input.
    expect(mapped.fieldErrors).toMatchObject({ handle: expect.stringContaining('kebab-case') });
    expect(mapped).not.toHaveProperty('refusal');

    const user = userEvent.setup();
    render(
      <ProductForm
        action={async () => mapped}
        categories={[]}
        submitLabel="Save"
        defaultValues={NEW_PRODUCT}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const input = screen.getByLabelText(/Handle/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy as string)).toHaveTextContent(/kebab-case/);
  });

  it('409 conflict is reported, not swallowed', async () => {
    const result = await asking('createProduct', 409, {
      path: PRODUCTS,
      method: 'POST',
      body: NEW_PRODUCT,
    });
    const mapped = toActionResult(result, KNOWN);

    if (mapped.status !== 'error') throw new Error('expected a refusal');
    // Either under a field or at form level, but never nowhere.
    expect(
      Object.keys(mapped.fieldErrors).length + (mapped.formError === null ? 0 : 1),
    ).toBeGreaterThan(0);
    expect(mapped).not.toHaveProperty('refusal');
  });

  /**
   * There is no 403 or 401 test here, and that is a fact about the spec rather than a gap in the
   * app: **no catalog operation in `admin-api.yaml` documents a `401` or `403` response**, even
   * though every one carries an `x-permission` and the API will certainly refuse a caller without
   * the relation. `Prefer: code=403` therefore cannot be honoured — Prism can only return what is
   * written down. Filed as CONTRACT CHANGE #180.
   *
   * The chain itself is covered: `states.test.tsx` drives a real documented `403` (on a registry
   * operation) through `adminRequest` into the panel, and `test/catalog-refusals.test.tsx` covers
   * every catalog mutation's refusal path with a synthesized result. What is missing is only the
   * spec's own example to test against.
   */
  it('has no documented refusal to drive, so Prism answers normally', async () => {
    const result = await asking('updateProduct', 403, {
      path: `${PRODUCTS}/${SEED_STORE_ID}`,
      method: 'PATCH',
      body: NEW_PRODUCT,
    });
    // Not an assertion about what *should* happen — a record of what the spec currently allows.
    expect(result.status).not.toBe(403);
  });
});

/**
 * The screens themselves, driven against Prism — not just the wrappers.
 *
 * `next/cache` and the session are stubbed above, so the real server actions run: a click on
 * `PublishControls` is a real `POST …/publish` and what the badge shows afterwards is what the
 * spec's example says. This is the layer where a renamed response field would surface — the
 * wrapper tests above would still pass with the field missing, but a badge cannot render
 * `status` that is not there.
 */
describe('the screens against the spec', () => {
  const CLASSIC_TEE_ID = '30000000-0000-4000-8000-000000000201';

  async function classicTee() {
    const result = await api.getProduct(SEED_STORE_ID, CLASSIC_TEE_ID);
    if (!result.ok) throw new Error(`getProduct failed: ${result.status}`);
    return result.data;
  }

  it('catalog list: listProducts rows link to the product', async () => {
    const query = parseTableQuery(
      new URLSearchParams(),
      PRODUCT_FILTER_KEYS,
      PRODUCTS_TABLE_DEFAULTS,
    );
    const result = await api.listProducts(
      SEED_STORE_ID,
      toContractQuery(query, { sortable: true }),
    );
    if (!result.ok) throw new Error('expected success');

    render(
      <ProductsTable
        storeId={SEED_STORE_ID}
        rows={result.data.items}
        total={result.data.total}
        query={query}
      />,
    );
    // `listProducts` has no example in the spec, so Prism generates the page from the schema; the
    // assertion is therefore about the shape — every row is a link to *its own* product — rather
    // than about a name.
    const first = result.data.items[0];
    if (first === undefined) throw new Error('Prism returned an empty page');
    const table = screen.getByRole('table', { name: 'Products' });
    const link = within(table).getByRole('link', { name: first.title });
    expect(link).toHaveAttribute('href', `/${SEED_STORE_ID}/catalog/${first.id}`);
  });

  it('product detail: status, variants and the gap the options imply', async () => {
    const product = await classicTee();
    render(
      <>
        <PublishControls storeId={SEED_STORE_ID} product={product} />
        <VariantsPanel storeId={SEED_STORE_ID} product={product} />
      </>,
    );

    expect(screen.getByText('published')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Published' })).toBeDisabled();
    const variants = screen.getByRole('table', { name: 'Variants' });
    expect(within(variants).getByText('TEE-M-RED')).toBeInTheDocument();
    // Size × Color is 3 × 2 and one exists, so five are offered — one button each, never silently.
    expect(screen.getByRole('button', { name: 'Create all 5' })).toBeInTheDocument();
  });

  it('publishing through the screen is a real POST, and the badge shows the response', async () => {
    const user = userEvent.setup();
    const product = { ...(await classicTee()), status: 'draft' as const, published_at: null };

    render(<PublishControls storeId={SEED_STORE_ID} product={product} />);
    expect(screen.getByText('draft')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(screen.getByRole('button', { name: 'Yes, publish' }));

    // The spec's `publishProduct` answers with the product example: published on 2026-09-04.
    expect(await screen.findByText('published')).toBeInTheDocument();
    expect(screen.getByText(/2026-09-04 00:00/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('creating a missing variant through the screen gets the 201 and shows no error', async () => {
    const user = userEvent.setup();
    render(<VariantsPanel storeId={SEED_STORE_ID} product={await classicTee()} />);

    await user.click(screen.getAllByRole('button', { name: 'Create' })[0] as HTMLElement);

    // A refusal would render an alert or a panel; a 201 renders neither and re-reads the product.
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('heading', { name: /do not have access/i })).toBeNull();
  });

  it('categories: the documented tree renders, and creating through the screen resets it', async () => {
    const user = userEvent.setup();
    const result = await api.listCategories(SEED_STORE_ID);
    if (!result.ok) throw new Error('expected success');

    render(<CategoriesPanel storeId={SEED_STORE_ID} categories={result.data.items} />);
    // The documented category is in the tree (by handle) and offered as a parent (by name).
    expect(screen.getByText('tops')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Tops' })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Name/), 'Shoes');
    await user.type(screen.getByLabelText(/^Handle/), 'shoes');
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    // 201 from Prism: the form resets for the next one. A refusal would leave the values in place.
    await vi.waitFor(() => expect(screen.getByLabelText(/^Handle/)).toHaveValue(''));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
