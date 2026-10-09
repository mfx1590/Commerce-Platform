import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingWizard } from '@/app/(hq)/onboarding/onboarding-wizard';
import { ActivatePanel } from '@/app/(hq)/onboarding/[storeId]/activate-panel';

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, back: vi.fn() }),
  usePathname: () => '/onboarding',
  redirect,
}));
const actions = vi.hoisted(() => ({ onboardStoreAction: vi.fn(), activateStoreAction: vi.fn() }));
vi.mock('@/app/actions/stores', () => actions);

const STORE = '00000000-0000-4000-8000-000000000034';
const ENTITY = {
  id: '00000000-0000-4000-8000-000000000011',
  label: 'Brand A B.V. (le-brand-a, NL)',
};

beforeEach(() => vi.clearAllMocks());

/** Walks the wizard with valid values to the review step. */
async function walkToReview(user: ReturnType<typeof userEvent.setup>) {
  render(<OnboardingWizard legalEntities={[ENTITY]} />);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByLabelText('Store code'), 'brand-c');
  await user.type(screen.getByLabelText('Store name'), 'Brand C');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByRole('textbox', { name: 'Primary domain' }), 'brand-c.localhost');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('region', { name: 'Review' })).toBeInTheDocument();
}

describe('the onboarding wizard', () => {
  it('a step does not advance with a bad field', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard legalEntities={[ENTITY]} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Store code'), 'Brand C');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/Lowercase letters, digits and single hyphens/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Primary domain' })).toBeNull();
  });

  it('the 201 shows the key once; Done drops it and goes to readiness, never via the URL', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'success',
      data: {
        repeat: false,
        storeId: STORE,
        storeCode: 'brand-c',
        key: 'plain-words-one-time-value',
        keyPrefix: 'plainwords',
      },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(actions.onboardStoreAction).toHaveBeenCalledWith(
      expect.objectContaining({
        legal_entity_mode: 'existing',
        legal_entity_id: ENTITY.id,
        code: 'brand-c',
        hostname: 'brand-c.localhost',
      }),
    );
    expect(await screen.findByTestId('onboarding-key')).toHaveTextContent(
      'plain-words-one-time-value',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/shown once and cannot be retrieved again/);

    await user.click(screen.getByRole('button', { name: /Done/ }));
    expect(push).toHaveBeenCalledWith(`/onboarding/${STORE}`);
    expect(String(push.mock.calls[0]?.[0])).not.toContain('plain-words');
    expect(document.body.innerHTML).not.toContain('plain-words-one-time-value');
  });

  it('the 200 repeat says the store exists and shows no key', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'success',
      data: { repeat: true, storeId: STORE, storeCode: 'brand-c', key: null, keyPrefix: null },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /already exists with exactly this definition/,
    );
    expect(screen.queryByTestId('onboarding-key')).toBeNull();
  });

  it('a 409 on a taken hostname puts the reader on the domain step, under the field', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'hostname "brand-c.localhost" is already in use',
      details: { field: 'domain.hostname' },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(await screen.findByRole('textbox', { name: 'Primary domain' })).toBeInTheDocument();
    expect(screen.getAllByText(/is already in use/).length).toBeGreaterThan(0);
  });

  it('a 409 "different definition" goes to the first step that owns what differs', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'store "brand-c" already exists with a different definition',
      details: { field: 'code', differs: ['name', 'hostname'] },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(await screen.findByLabelText('Store code')).toBeInTheDocument();
    expect(screen.getByText(/different definition/)).toBeInTheDocument();
  });

  it('a 422 lists each offending settings key on the store step', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'invalid store settings',
      details: { settings: { 'payment.invoice_allowed': 'boolean' } },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(await screen.findByText('payment.invoice_allowed: boolean')).toBeInTheDocument();
  });
});

describe('the readiness panel', () => {
  it('lists exactly the 409 details.missing, and Activate succeeds when nothing is missing', async () => {
    const user = userEvent.setup();
    actions.activateStoreAction.mockResolvedValueOnce({
      status: 'error',
      fieldErrors: { status: 'Cannot activate: …' },
      formError: 'Cannot activate: …',
      missing: ['primary_domain', 'publishable_key'],
    });
    render(<ActivatePanel storeId={STORE} status="draft" />);
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    const list = await screen.findByRole('list', { name: 'Missing prerequisites' });
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'a primary domain',
      'a live publishable key',
    ]);

    actions.activateStoreAction.mockResolvedValueOnce({
      status: 'success',
      data: { id: STORE, status: 'active' },
    });
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('an active store says so and offers nothing', () => {
    render(<ActivatePanel storeId={STORE} status="active" />);
    expect(screen.getByRole('status')).toHaveTextContent(/Active/);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('/stores/new', () => {
  it('redirects to the wizard', async () => {
    const { default: NewStorePage } = await import('@/app/(hq)/stores/new/page');
    try {
      NewStorePage();
    } catch {
      // next/navigation's redirect throws in the real thing; the mock records the call.
    }
    expect(redirect).toHaveBeenCalledWith('/onboarding');
  });
});
