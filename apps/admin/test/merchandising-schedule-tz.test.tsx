/**
 * #963 review (BLOCK): schedule times. The person types in THEIR zone; the browser turns that into
 * a UTC instant before the action is called; an untouched schedule is sent back byte for byte (the
 * input has minutes only, so converting it back would drop seconds and move the time). This file
 * pins the zone to New York (UTC−5 in winter) so a zone bug cannot hide behind a UTC test machine.
 */
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'America/New_York';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RulesScreen } from '@/app/(store)/[storeId]/catalog/merchandising/rules-screen';
import { isoToLocalInput, localToIso, scheduleValue } from '@/lib/catalog/merchandising';
import type { MerchandisingRule } from '@/lib/catalog/merchandising';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
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
// Seconds, and an offset spelling: both must come back exactly as the API gave them.
const STARTS = '2026-12-01T09:00:30Z';
const ENDS = '2026-12-31T23:00:00+00:00';
const RULE: MerchandisingRule = {
  id: '30000000-0000-4000-8000-000000000501',
  scope: { type: 'category', category_id: CAT, query: null },
  pins: [],
  boosts: [],
  buries: [],
  enabled: true,
  starts_at: STARTS,
  ends_at: ENDS,
  published_at: '2026-11-20T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};

function openEditor() {
  render(
    <RulesScreen
      storeId="s1"
      rules={[RULE]}
      categories={[{ id: CAT, name: 'Kitchen' }]}
      categoriesError={null}
      products={{}}
      unreadNames={0}
      filters={{}}
      canAdmin
      now="2026-11-25T12:00:00.000Z"
    />,
  );
}

// The zone is per process: give it back, so no other suite in this worker runs in New York.
afterAll(() => {
  if (TZ_BEFORE === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_BEFORE;
});

beforeEach(() => {
  vi.clearAllMocks();
  actions.updateRuleAction.mockResolvedValue({ status: 'success', data: RULE });
});

describe('schedule times in a non-UTC zone', () => {
  it('the zone is really pinned', () => {
    expect(new Date('2026-12-01T12:00').getTimezoneOffset()).toBe(300);
  });

  it('the conversions: typed local time ↔ UTC instant', () => {
    expect(localToIso('2026-12-01T04:00')).toBe('2026-12-01T09:00:00.000Z');
    expect(isoToLocalInput(STARTS)).toBe('2026-12-01T04:00');
    expect(scheduleValue(STARTS, '2026-12-01T04:00', '2026-12-01T04:00')).toBe(STARTS);
    expect(localToIso('2026-12-01 04:00')).toBeUndefined();
  });

  it('the table shows the window in UTC, said', () => {
    openEditor();
    expect(screen.getByText('2026-12-01 09:00 UTC → 2026-12-31 23:00 UTC')).toBeInTheDocument();
  });

  it('an unchanged schedule saves byte-identical', async () => {
    const user = userEvent.setup();
    openEditor();
    await user.click(screen.getByRole('button', { name: 'Edit Category Kitchen' }));
    // Shown in the person's own time: 09:00:30Z is 04:00 in New York.
    expect(screen.getByLabelText('Starts')).toHaveValue('2026-12-01T04:00');
    expect(screen.getByLabelText('Ends')).toHaveValue('2026-12-31T18:00');
    await user.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(actions.updateRuleAction).toHaveBeenCalledTimes(1);
    const sent = actions.updateRuleAction.mock.calls[0]![2];
    expect(sent.starts_at).toBe(STARTS);
    expect(sent.ends_at).toBe(ENDS);
    expect(sent.enabled).toBe(false);
  });

  it('a changed end is the typed New York time as a UTC instant; the untouched start stays exact', async () => {
    const user = userEvent.setup();
    openEditor();
    await user.click(screen.getByRole('button', { name: 'Edit Category Kitchen' }));
    const ends = screen.getByLabelText('Ends');
    await user.clear(ends);
    await user.type(ends, '2027-01-10T08:00');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    const sent = actions.updateRuleAction.mock.calls[0]![2];
    expect(sent.ends_at).toBe('2027-01-10T13:00:00.000Z');
    expect(sent.starts_at).toBe(STARTS);
  });
});
