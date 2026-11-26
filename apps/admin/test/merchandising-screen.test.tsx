/**
 * Search merchandising, the screen (#870 wave 1 item 5, PR C): filters in the URL, read-only for
 * store_staff, rules naming products shoppers would not see, the publish result per rule (and the
 * API's counts disagreeing, said), the editor choosing products by name and holding Save on a
 * problem.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RulesScreen } from '@/app/(store)/[storeId]/catalog/merchandising/rules-screen';
import type { MerchandisingRule } from '@/lib/catalog/merchandising';

const replace = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh, back: vi.fn() }),
  usePathname: () => '/s1/catalog/merchandising',
}));
const actions = vi.hoisted(() => ({
  bulkRulesAction: vi.fn(),
  publishRulesAction: vi.fn(),
  createRuleAction: vi.fn(),
  updateRuleAction: vi.fn(),
  searchProductsForRuleAction: vi.fn(),
}));
vi.mock('@/app/actions/merchandising', () => actions);

const CAT = '00000000-0000-4000-8000-000000000201';
const P1 = '00000000-0000-4000-8000-000000000301';
const P2 = '00000000-0000-4000-8000-000000000302';
const P3 = '00000000-0000-4000-8000-000000000303';
const NOW = '2026-11-25T12:00:00.000Z';

const base = {
  pins: [] as string[],
  boosts: [] as { product_id: string; weight: number }[],
  buries: [] as string[],
  enabled: true,
  starts_at: null,
  ends_at: null,
  published_at: '2026-11-20T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};
const KITCHEN: MerchandisingRule = {
  ...base,
  id: '30000000-0000-4000-8000-000000000501',
  scope: { type: 'category', category_id: CAT, query: null },
  pins: [P1, P2],
  boosts: [{ product_id: P3, weight: 60 }],
  updated_at: '2026-11-21T00:00:00Z',
};
const TOWEL: MerchandisingRule = {
  ...base,
  id: '30000000-0000-4000-8000-000000000502',
  scope: { type: 'query', category_id: null, query: 'towel' },
  enabled: false,
  published_at: null,
};

function screenFor({ canAdmin = true, filters = {} as Record<string, string> } = {}) {
  return render(
    <RulesScreen
      storeId="s1"
      rules={[KITCHEN, TOWEL]}
      categories={[{ id: CAT, name: 'Kitchen' }]}
      categoriesError={null}
      products={{
        [P1]: { title: 'Linen tea towel', status: 'published' },
        [P2]: { title: null, status: 'missing' },
        [P3]: { title: 'Apron', status: 'archived' },
      }}
      unreadNames={0}
      filters={filters}
      canAdmin={canAdmin}
      now={NOW}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('the rules list', () => {
  it('each rule: scope in words, state, counts, never published / changed since, products shoppers would not see', () => {
    screenFor();
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Category Kitchen');
    expect(rows[0]).toHaveTextContent('Live');
    expect(rows[0]).toHaveTextContent('2 / 1 / 0');
    expect(rows[0]).toHaveTextContent('changed since');
    expect(rows[0]).toHaveTextContent(
      '1 product no longer exists; 1 not published (draft or archived)',
    );
    expect(rows[1]).toHaveTextContent('Search “towel”');
    expect(rows[1]).toHaveTextContent('Disabled');
    expect(rows[1]).toHaveTextContent('never published');
  });

  it('filters go to the URL and apply to the full list', async () => {
    const user = userEvent.setup();
    screenFor();
    await user.selectOptions(screen.getByLabelText('State'), 'disabled');
    expect(replace).toHaveBeenCalledWith('/s1/catalog/merchandising?state=disabled');
    screenFor({ filters: { scope: 'query' } });
    expect(screen.getAllByText(/1 of 2 rules match the filters/)[0]).toBeInTheDocument();
  });

  it('store_staff reads: no New rule, no publish, no selection, no edit', () => {
    screenFor({ canAdmin: false });
    expect(screen.queryByRole('button', { name: 'New rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish to search/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
  });

  it('ticking a rule offers Enable, Disable and Delete…', async () => {
    const user = userEvent.setup();
    screenFor();
    await user.click(screen.getByRole('checkbox', { name: 'Select Search “towel”' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    for (const name of ['Enable', 'Disable', 'Delete…']) {
      expect(within(bar).getByRole('button', { name })).toBeInTheDocument();
    }
  });
});

describe('Publish to search', () => {
  it('says what a publish now does, asks, then reports every rule and a disagreement', async () => {
    const user = userEvent.setup();
    actions.publishRulesAction.mockResolvedValue({
      status: 'success',
      data: {
        index: 'brand-a_products',
        published: 2,
        skipped: 1,
        mismatch:
          'The search service counted 2 published and 1 skipped; the rules read back show 1 published and 1 skipped.',
        rows: [
          { id: KITCHEN.id, outcome: 'published', why: 'In the index since 2026-11-25T12:00:01Z.' },
          { id: TOWEL.id, outcome: 'skipped', why: 'Disabled.' },
        ],
      },
    });
    screenFor();
    expect(screen.getByText(/A publish now puts/)).toHaveTextContent(
      'A publish now puts 1 live rule in the search index and skips 1',
    );
    await user.click(screen.getByRole('button', { name: 'Publish to search…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, publish' }));
    const result = await screen.findByRole('region', { name: 'Publish result' });
    expect(within(result).getByRole('status')).toHaveTextContent(
      'Published to brand-a_products: 2 in the index, 1 skipped.',
    );
    expect(within(result).getByRole('alert')).toHaveTextContent('counted 2 published');
    expect(within(result).getByText('Category Kitchen').closest('li')).toHaveTextContent(
      'Published',
    );
    expect(within(result).getByText('Search “towel”').closest('li')).toHaveTextContent(
      'SkippedSearch “towel”Disabled.',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('a refused publish shows the reason; nothing is reported as published', async () => {
    const user = userEvent.setup();
    actions.publishRulesAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError:
        'Nothing was published: no search credentials (the store has no search index or credentials set up).',
    });
    screenFor();
    await user.click(screen.getByRole('button', { name: 'Publish to search…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, publish' }));
    expect(await screen.findByText(/Nothing was published/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Publish result' })).not.toBeInTheDocument();
  });
});

describe('the editor', () => {
  it('products are chosen by name; one already in a list is not offered twice; the scope is fixed on edit', async () => {
    const user = userEvent.setup();
    actions.searchProductsForRuleAction.mockResolvedValue({
      status: 'success',
      data: [
        { id: P1, title: 'Linen tea towel', status: 'published' },
        { id: '00000000-0000-4000-8000-000000000304', title: 'Oven glove', status: 'draft' },
      ],
    });
    actions.updateRuleAction.mockResolvedValue({ status: 'success', data: KITCHEN });
    screenFor();
    await user.click(screen.getByRole('button', { name: 'Edit Category Kitchen' }));
    const form = screen.getByRole('form', { name: 'Edit Category Kitchen' });
    expect(within(form).getByRole('radio', { name: 'A category' })).toBeDisabled();
    await user.type(within(form).getByLabelText('Find a product to add to buried'), 'o');
    fireEvent.keyDown(within(form).getByLabelText('Find a product to add to buried'), {
      key: 'Enter',
    });
    const found = await within(form).findByRole('list', { name: 'Products to add to buried' });
    expect(
      within(found).getByRole('button', { name: 'Add Linen tea towel to buried' }),
    ).toBeDisabled();
    expect(within(found).getByText(/draft: not shown to shoppers/)).toBeInTheDocument();
    await user.click(within(found).getByRole('button', { name: 'Add Oven glove to buried' }));
    await user.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(actions.updateRuleAction).toHaveBeenCalledWith(
      's1',
      KITCHEN.id,
      expect.objectContaining({
        pins: [P1, P2],
        buries: ['00000000-0000-4000-8000-000000000304'],
      }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('a bad weight holds Save and says why', async () => {
    const user = userEvent.setup();
    screenFor();
    await user.click(screen.getByRole('button', { name: 'Edit Category Kitchen' }));
    const weight = screen.getByRole('spinbutton', { name: 'Weight of Apron' });
    await user.clear(weight);
    await user.type(weight, '150');
    expect(screen.getByText('A boost weight is a whole number from 1 to 100.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save rule' })).toBeDisabled();
  });

  it('pins move up and down', async () => {
    const user = userEvent.setup();
    actions.updateRuleAction.mockResolvedValue({ status: 'success', data: KITCHEN });
    screenFor();
    await user.click(screen.getByRole('button', { name: 'Edit Category Kitchen' }));
    await user.click(screen.getByRole('button', { name: 'Move Linen tea towel down' }));
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(actions.updateRuleAction).toHaveBeenCalledWith(
      's1',
      KITCHEN.id,
      expect.objectContaining({ pins: [P2, P1] }),
    );
  });
});
