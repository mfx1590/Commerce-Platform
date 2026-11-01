/**
 * "Draft with AI" on the product page (#608): every documented refusal is said and the editor
 * keeps working; Retry-After counts down on the button; the brand-voice hint; the side-by-side diff;
 * the save sends only the accepted fields; the button is gated below store_staff.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyDraftPanel } from '@/app/(store)/[storeId]/catalog/[productId]/copy-draft-panel';
import { describeDraftError } from '@/lib/copy-drafts';

vi.mock('server-only', () => ({}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/',
}));
const actions = vi.hoisted(() => ({
  draftProductCopyAction: vi.fn(),
  saveProductCopyAction: vi.fn(),
}));
vi.mock('@/app/actions/copy-drafts', () => actions);

const STORE = '00000000-0000-4000-8000-000000000031';
const PRODUCT = '50000000-0000-4000-8000-000000000001';
const current = {
  title: 'Tea towel',
  description: 'Old line one.\nOld line two.',
  bullets: [],
  seo: { title: 'Old SEO', description: '' },
};
const product = { description: 'Old line one.\nOld line two.', seo: { title: 'Old SEO' } };
const draft = (over: Record<string, unknown> = {}) => ({
  product_id: PRODUCT,
  locale: 'en-GB',
  fields: ['title', 'description', 'bullets'],
  draft: {
    title: 'Linen tea towel',
    description: 'Old line one.\nNew line two.',
    bullets: ['100% linen', '50 x 70 cm'],
  },
  brand_voice_source: 'settings',
  model: 'claude-sonnet-5-5',
  template: { id: 'product-copy-draft', version: 2 },
  created_at: '2026-11-01T09:00:00Z',
  ...over,
});

function renderPanel(props: Partial<Parameters<typeof CopyDraftPanel>[0]> = {}) {
  return render(
    <CopyDraftPanel
      storeId={STORE}
      productId={PRODUCT}
      locales={['en-GB', 'nl-NL']}
      defaultLocale="en-GB"
      canDraft
      current={current}
      product={product}
      settingsHref={`/${STORE}/settings`}
      {...props}
    />,
  );
}

const errorOf = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
  retryAfterSeconds?: number,
) => ({
  status: 'error' as const,
  error: describeDraftError({
    status,
    error: { code, message: code, ...(details === undefined ? {} : { details }) },
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('every refusal is said and the editor keeps working', () => {
  const cases: Array<[string, ReturnType<typeof errorOf>, RegExp]> = [
    ['ai_disabled', errorOf(503, 'ai_disabled'), /AI drafting is switched off/],
    [
      'ai_budget_exceeded',
      errorOf(429, 'ai_budget_exceeded', {
        used_tokens: 10,
        limit_tokens: 10,
        resets_at: '2026-12-01T00:00:00Z',
      }),
      /monthly AI budget is used up.*resets on 2026-12-01 00:00 UTC/,
    ],
    [
      'ai_refused',
      errorOf(422, 'ai_refused', { category: 'policy' }),
      /declined.*Reword the product's facts/,
    ],
    ['ai_unavailable', errorOf(502, 'ai_unavailable'), /did not answer.*Try again/],
    ['ai_invalid_draft', errorOf(502, 'ai_invalid_draft'), /came back incomplete.*Try again/],
    [
      'unavailable',
      errorOf(503, 'unavailable'),
      /Drafting is unavailable right now.*Nothing was sent/,
    ],
  ];

  it.each(cases)('%s', async (_name, result, words) => {
    actions.draftProductCopyAction.mockResolvedValue(result);
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(words);
    expect(alert).toHaveTextContent('The editor below works as before.');
    expect(screen.queryByRole('region', { name: 'AI draft' })).toBeNull();
    expect(actions.saveProductCopyAction).not.toHaveBeenCalled();
  });

  it('ai_rate_limited counts Retry-After down on the button, then it works again', async () => {
    // Real timers: the countdown is wall-clock, so assert "disabled with a countdown", then wait
    // (bounded) for it to work again — no exact-second label under a loaded runner.
    actions.draftProductCopyAction.mockResolvedValueOnce(
      errorOf(429, 'ai_rate_limited', { limit_per_minute: 10 }, 2),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait 2 s and try again.');
    expect(screen.getByRole('button', { name: /^Draft with AI \(wait [12] s\)$/ })).toBeDisabled();
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Draft with AI' })).toBeEnabled(),
      { timeout: 5000 },
    );
  });

  it('a 403 is the refusal panel', async () => {
    actions.draftProductCopyAction.mockResolvedValue({
      status: 'refused',
      refusal: {
        status: 403,
        error: {
          code: 'forbidden',
          message: 'requires store_staff',
          details: { relation: 'store_staff', object: `store:${STORE}` },
        },
      },
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    expect(await screen.findByText(/store_staff/)).toBeInTheDocument();
  });
});

describe('a draft', () => {
  it('is requested for the chosen locale and fields', async () => {
    actions.draftProductCopyAction.mockResolvedValue({ status: 'success', draft: draft() });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByLabelText('Title'));
    await user.click(screen.getByLabelText('Bullets'));
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    expect(actions.draftProductCopyAction).toHaveBeenCalledWith(STORE, PRODUCT, {
      locale: 'en-GB',
      fields: ['title', 'description', 'bullets'],
    });
  });

  it('shows current beside the draft, the changed lines, and the model and template', async () => {
    actions.draftProductCopyAction.mockResolvedValue({ status: 'success', draft: draft() });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    const region = await screen.findByRole('region', { name: 'AI draft' });
    expect(within(region).getByLabelText('Current Title')).toHaveTextContent('Tea towel');
    expect(within(region).getByLabelText('Draft Title')).toHaveValue('Linen tea towel');
    const changes = within(region).getByRole('list', { name: 'Changes to Description' });
    expect(changes).toHaveTextContent('removed: Old line two.');
    expect(changes).toHaveTextContent('added: New line two.');
    expect(within(region).getByLabelText('Draft provenance')).toHaveTextContent(
      'Model claude-sonnet-5-5 · template product-copy-draft v2 · en-GB',
    );
    expect(within(region).queryByRole('note')).toBeNull();
    expect(actions.saveProductCopyAction).not.toHaveBeenCalled();
  });

  it('a default brand voice links to the store setting', async () => {
    actions.draftProductCopyAction.mockResolvedValue({
      status: 'success',
      draft: draft({ brand_voice_source: 'default' }),
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(/no brand voice yet/);
    expect(within(note).getByRole('link')).toHaveAttribute('href', `/${STORE}/settings`);
  });

  it('is saved only on Save, with the edits, and only the accepted fields', async () => {
    actions.draftProductCopyAction.mockResolvedValue({ status: 'success', draft: draft() });
    actions.saveProductCopyAction.mockResolvedValue({ status: 'success', data: { id: PRODUCT } });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    const region = await screen.findByRole('region', { name: 'AI draft' });
    const title = within(region).getByLabelText('Draft Title');
    await user.clear(title);
    await user.type(title, 'Linen tea towel, natural');
    // Keep title and bullets; drop the description.
    const descriptionBox = within(region)
      .getByRole('heading', { name: 'Description' })
      .closest('div')!.parentElement!;
    await user.click(within(descriptionBox).getByLabelText('Use this field'));
    await user.click(within(region).getByRole('button', { name: 'Save to product' }));
    expect(actions.saveProductCopyAction).toHaveBeenCalledWith(STORE, PRODUCT, {
      title: 'Linen tea towel, natural',
      description: 'Old line one.\nOld line two.\n\n- 100% linen\n- 50 x 70 cm',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Saved title, bullets to the product.',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('a draft in another locale can be read but not saved over the one copy', async () => {
    actions.draftProductCopyAction.mockResolvedValue({
      status: 'success',
      draft: draft({ locale: 'nl-NL' }),
    });
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(screen.getByLabelText('Locale'), 'nl-NL');
    expect(screen.getByText(/holds one copy, in en-GB/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#670' })).toHaveAttribute(
      'href',
      'https://github.com/mfx1590/Commerce-Platform/issues/670',
    );
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    const region = await screen.findByRole('region', { name: 'AI draft' });
    expect(within(region).getByRole('button', { name: 'Save to product' })).toBeDisabled();
    expect(within(region).getByText(/default locale \(en-GB\) only/)).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Copy draft Title' })).toBeEnabled();
  });

  it('a refused save is said and the draft stays', async () => {
    actions.draftProductCopyAction.mockResolvedValue({ status: 'success', draft: draft() });
    actions.saveProductCopyAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'An SEO title is at most 70 characters.',
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    const region = await screen.findByRole('region', { name: 'AI draft' });
    await user.click(within(region).getByRole('button', { name: 'Save to product' }));
    expect(await screen.findByText('An SEO title is at most 70 characters.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'AI draft' })).toBeInTheDocument();
  });
});

describe('the role gate', () => {
  it('below store_staff the button is disabled and says why (the server decides anyway)', () => {
    renderPanel({ canDraft: false });
    expect(screen.getByRole('button', { name: 'Draft with AI' })).toBeDisabled();
    expect(screen.getByText(/needs/)).toHaveTextContent(`store_staff on store:${STORE}`);
  });
});
