/**
 * Product media, the screen (#870 wave 1 item 5, PR B): the missing-alt warning, the thumbnail,
 * delete behind a confirmation, upload refused without alt text before the server is asked, and
 * the edit page's Details form never sending `media` (the core REPLACES the set when it is sent).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPanel } from '@/app/(store)/[storeId]/catalog/[productId]/media-panel';
import { ProductForm } from '@/app/(store)/[storeId]/catalog/product-form';
import type { AdminComponents } from '@/lib/api/admin-client';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/',
}));
const actions = vi.hoisted(() => ({
  uploadProductMediaAction: vi.fn(),
  updateProductMediaAction: vi.fn(),
  moveProductMediaAction: vi.fn(),
  deleteProductMediaAction: vi.fn(),
}));
vi.mock('@/app/actions/media', () => actions);

const STORE = '00000000-0000-4000-8000-000000000031';
const PRODUCT = '10000000-0000-4000-8000-000000000001';
const VARIANT = '20000000-0000-4000-8000-000000000001';
const url = (n: number) => `https://res.cloudinary.com/brand-a/image/upload/v1/p/${n}.jpg`;
const item = (
  n: number,
  alt: string | null,
  extra: Partial<AdminComponents['ProductMedia']> = {},
) =>
  ({
    id: `60000000-0000-4000-8000-00000000000${n}`,
    url: url(n),
    alt,
    position: n,
    variant_id: null,
    variants: { thumb: url(n), pdp: url(n), zoom: url(n) },
    ...extra,
  }) as AdminComponents['ProductMedia'];

const MEDIA = [
  item(1, 'Folded towel'),
  item(0, null),
  item(2, 'Towel, blue', { variant_id: VARIANT }),
];
const VARIANTS = [{ id: VARIANT, title: 'Blue' }];

function panel(canEdit = true) {
  return render(
    <MediaPanel
      storeId={STORE}
      productId={PRODUCT}
      media={MEDIA}
      variants={VARIANTS}
      canEdit={canEdit}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('MediaPanel', () => {
  it('orders by position, marks the thumbnail, says how many lack alt text', () => {
    panel();
    const items = within(screen.getByRole('list', { name: 'Product images' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveAccessibleName('Image 1: image 1');
    expect(within(items[0]!).getByText('thumbnail')).toBeInTheDocument();
    expect(within(items[0]!).getByText('no alt text')).toBeInTheDocument();
    // the badge, beside the selected option
    expect(within(items[2]!).getAllByText('Blue')).toHaveLength(2);
    expect(screen.getByRole('note')).toHaveTextContent('1 image has no alt text');
    // alt="" (none yet) makes it presentational, so it is found by tag.
    expect(items[0]!.querySelector('img')).toHaveAttribute('src', url(0));
    expect(items[1]!.querySelector('img')).toHaveAttribute('alt', 'Folded towel');
  });

  it('read-only without the permission: no upload, no edit controls', () => {
    panel(false);
    expect(screen.queryByRole('form', { name: 'Upload an image' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('delete asks first; Cancel deletes nothing; Yes deletes that image', async () => {
    const user = userEvent.setup();
    actions.deleteProductMediaAction.mockResolvedValue({ status: 'success', data: null });
    panel();
    await user.click(screen.getByRole('button', { name: 'Delete Folded towel' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Folded towel?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(actions.deleteProductMediaAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete Folded towel' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(actions.deleteProductMediaAction).toHaveBeenCalledWith(STORE, PRODUCT, MEDIA[0]!.id);
    expect(refresh).toHaveBeenCalled();
  });

  it('moving the second image earlier makes it position 0', async () => {
    const user = userEvent.setup();
    actions.moveProductMediaAction.mockResolvedValue({ status: 'success', data: {} });
    panel();
    expect(screen.getByRole('button', { name: 'Move image 1 earlier' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Folded towel earlier' }));
    expect(actions.moveProductMediaAction).toHaveBeenCalledWith(STORE, PRODUCT, MEDIA[0]!.id, 0);
  });

  it('upload without alt text is refused before the server is asked', async () => {
    const user = userEvent.setup();
    panel();
    const form = screen.getByRole('form', { name: 'Upload an image' });
    await user.upload(
      within(form).getByLabelText('Image file'),
      new File([new Uint8Array([0xff, 0xd8, 0xff])], 'towel.jpg', { type: 'image/jpeg' }),
    );
    // jsdom does not see user-event files for the required check: submit the form directly.
    fireEvent.submit(form);
    expect(actions.uploadProductMediaAction).not.toHaveBeenCalled();
    expect(within(form).getByRole('alert')).toHaveTextContent(/alt/i);
  });

  it('a refused upload shows the server’s reason on the file', async () => {
    const user = userEvent.setup();
    actions.uploadProductMediaAction.mockResolvedValue({
      status: 'error',
      fieldErrors: { file: 'That file is not an image in a supported format.' },
      formError: null,
    });
    panel();
    const form = screen.getByRole('form', { name: 'Upload an image' });
    await user.upload(
      within(form).getByLabelText('Image file'),
      new File(['x'], 'a.jpg', { type: 'image/jpeg' }),
    );
    await user.type(within(form).getByLabelText('Alt text (required)'), 'A towel');
    // jsdom does not see user-event files for the required check: submit the form directly.
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toHaveTextContent('not an image');
  });
});

describe('the edit page Details form', () => {
  it('with mediaInPanel: no URL list, and `media` is never sent', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'error', fieldErrors: {}, formError: null });
    render(
      <ProductForm
        action={action}
        categories={[]}
        submitLabel="Save changes"
        mediaInPanel
        defaultValues={{
          handle: 'tea-towel',
          title: 'Tea towel',
          options: [],
          media: [{ url: url(1), alt: 'Folded towel' }],
        }}
      />,
    );
    expect(screen.queryByRole('heading', { name: 'Media' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![0]).not.toHaveProperty('media');
  });
});
