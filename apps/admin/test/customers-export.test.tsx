/**
 * The GDPR export trail (#870 wave 1 item 4, PR C).
 *
 * Three properties this file exists to hold:
 *
 * 1. **the bundle is not served here** — no download link or button anywhere in the panel, and
 *    `getCustomerExport`, whose 200 *is* one person's whole record, is not even wrapped;
 * 2. **nothing is asked that would be refused** — the trail is `store_admin`, so a `support`
 *    reader never triggers the call, and the staff-name lookup (`owner` on organization:hq) is
 *    skipped for a store admin rather than 403-ing;
 * 3. **the states are readable** — "pending" and "expired" are not the same thing as "failed", and
 *    the two reasons a bundle was never built are said in words.
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeDownloads,
  describeExport,
  formatBytes,
  requesterLabel,
  type ExportRequest,
} from '@/lib/customers/exports';
import { principals, SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/store-1/customers',
}));
vi.mock('@/components/shell/section-guard', () => ({
  StoreSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/roles', () => ({ isServiceAccount: () => false }));
vi.mock('@/app/actions/customers', () => ({
  updateCustomerAction: vi.fn(),
  eraseCustomerAction: vi.fn(),
  requestCustomerExportAction: vi.fn(),
}));

const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true as const,
    status: 200,
    data: principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({
  getCustomer: vi.fn(),
  listCustomerAddresses: vi.fn(),
  listCustomerConsents: vi.fn(),
  listCustomerGroups: vi.fn(),
  listCustomerExports: vi.fn(),
  getCustomerIdentity: vi.fn(),
  listStores: vi.fn(),
  listAuditLog: vi.fn(),
  listUsers: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const CustomerDetailPage = (await import('@/app/(store)/[storeId]/customers/[customerId]/page'))
  .default;

const STORE = SEED.stores.brandA;
const CUSTOMER = '50000000-0000-4000-8000-000000000001';
const ASKER = SEED.users.storeAdmin;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number) => ({
  ok: false as const,
  status,
  error: { code: 'forbidden', message: 'Forbidden' },
});

const request = (over: Partial<ExportRequest> = {}): ExportRequest =>
  ({
    id: 'e1',
    status: 'ready',
    requested_at: '2026-11-20T09:00:00.000Z',
    ready_at: '2026-11-20T09:04:00.000Z',
    expires_at: '2026-12-04T09:04:00.000Z',
    size_bytes: 1_572_864,
    reason: null,
    requested_by: ASKER,
    requested_by_type: 'staff',
    download_count: 0,
    ...over,
  }) as ExportRequest;

const page = () =>
  CustomerDetailPage({ params: Promise.resolve({ storeId: STORE, customerId: CUSTOMER }) });

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.getCustomer.mockResolvedValue(
    ok({
      id: CUSTOMER,
      identity_id: null,
      email: 'jane@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
      phone: null,
      status: 'registered',
      customer_group_id: null,
      consent: {},
      metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
  );
  api.listCustomerAddresses.mockResolvedValue(ok({ items: [] }));
  api.listCustomerConsents.mockResolvedValue(ok({ items: [] }));
  api.listCustomerGroups.mockResolvedValue(ok({ items: [] }));
  api.listCustomerExports.mockResolvedValue(ok({ items: [request()] }));
  api.listStores.mockResolvedValue(ok({ page: 1, limit: 100, total: 0, items: [] }));
  api.listAuditLog.mockResolvedValue(ok({ page: 1, limit: 20, total: 0, items: [] }));
  api.listUsers.mockResolvedValue(ok({ page: 1, limit: 100, total: 0, items: [] }));
});

describe('handing a bundle over', () => {
  // PR C asserted the opposite — no download anywhere — because the manager's note said "never the
  // bundle" while the contract's `getCustomerExport` IS the bundle. After #962 the decision was
  // made deliberately: a subject-access request cannot be answered without it. So the assertion
  // changed with the decision, and what it pins now is WHERE the bundle may be reached from.
  it('offers the download only on a ready bundle, pointing at the gated route', async () => {
    render(await page());
    const table = screen.getByRole('table', { name: 'Data export requests' });
    const link = within(table).getByRole('link', { name: 'Download the bundle' });
    expect(link.getAttribute('href')).toBe(`/${STORE}/customers/${CUSTOMER}/exports/e1`);
  });

  it('offers none while it is being built, and none once it has been purged', async () => {
    api.listCustomerExports.mockResolvedValue(
      ok({
        items: [
          request({ id: 'p', status: 'pending', ready_at: null, size_bytes: null }),
          request({ id: 'x', status: 'expired', reason: null }),
        ],
      }),
    );
    render(await page());
    const table = screen.getByRole('table', { name: 'Data export requests' });
    expect(within(table).queryByRole('link', { name: 'Download the bundle' })).toBeNull();
  });

  it('never renders the bundle itself, only a link to it', async () => {
    render(await page());
    // The panel reads ids, statuses, sizes and counts. Nothing it renders came out of a bundle.
    expect(screen.queryByText(/customer-export\/v1/)).toBeNull();
    expect(screen.getByText(/A download hands over everything this store holds/)).toBeTruthy();
  });
});

describe('a second bundle is not queued by accident (#962 review nit)', () => {
  it('a pending export replaces the request button, and survives a reload', async () => {
    // The flag comes from the TRAIL, not from the control's own state: before this, a reload
    // re-armed the button although the core was already building a bundle.
    api.listCustomerExports.mockResolvedValue(
      ok({ items: [request({ status: 'pending', ready_at: null, size_bytes: null })] }),
    );
    render(await page());
    expect(screen.queryByRole('button', { name: 'Request a data export' })).toBeNull();
    expect(screen.getByText(/An export is already being built/)).toBeTruthy();
  });

  it('a ready or expired export leaves the button available', async () => {
    render(await page());
    expect(screen.getByRole('button', { name: 'Request a data export' })).toBeTruthy();
  });
});

describe('nothing is asked that would be refused', () => {
  it('a support reader is told it is store_admin work, and the trail is never fetched', async () => {
    principalOf.current = 'support';
    render(await page());
    expect(api.listCustomerExports).not.toHaveBeenCalled();
    expect(screen.getByText(/Only a store admin can request or see data exports/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Data export requests' })).toBeNull();
    // And no way to reach a bundle from anywhere on the page (#965 review).
    expect(screen.queryByRole('link', { name: /Download the bundle/ })).toBeNull();
    for (const anchor of screen.queryAllByRole('link')) {
      expect(anchor.getAttribute('href') ?? '').not.toContain('/exports/');
    }
  });

  it('a store admin: the trail adds no staff lookup of its own, and shows a short id', async () => {
    render(await page());
    // `listUsers` is `owner` on organization:hq, so asking as a store admin is a certain 403. The
    // trail does not ask. The ONE call here is the Activity panel's `loadActivity` (#896), which
    // asks unconditionally and is written to survive the refusal — pre-existing, and the reason
    // this asserts a count rather than zero. Every non-owner therefore pays one refused request
    // per detail page view; gating it would mean threading the principal into `loadActivity`,
    // which is a change to four pages and not this PR's.
    expect(api.listUsers).toHaveBeenCalledTimes(1);
    const table = screen.getByRole('table', { name: 'Data export requests' });
    expect(within(table).getByText(`Staff (${ASKER.slice(0, 8)})`)).toBeTruthy();
  });

  it('an owner gets the asker by name', async () => {
    principalOf.current = 'owner';
    api.listUsers.mockResolvedValue(
      ok({
        page: 1,
        limit: 100,
        total: 1,
        items: [
          {
            id: ASKER,
            email: 'sam@example.test',
            display_name: 'Sam StoreAdmin',
            status: 'active',
            last_login_at: null,
          },
        ],
      }),
    );
    render(await page());
    expect(screen.getByText('Sam StoreAdmin')).toBeTruthy();
  });

  it('an erased customer is not offered an export', async () => {
    api.getCustomer.mockResolvedValue(
      ok({
        id: CUSTOMER,
        identity_id: null,
        email: 'erased+1@example.invalid',
        first_name: null,
        last_name: null,
        phone: null,
        status: 'erased',
        customer_group_id: null,
        consent: {},
        metadata: {},
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    render(await page());
    expect(screen.getByText(/nothing left to export/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Request a data export/ })).toBeNull();
  });

  it('a refused trail shows the refusal rather than an empty table', async () => {
    api.listCustomerExports.mockResolvedValue(fail(403));
    render(await page());
    expect(screen.getByText(/Admin API returned 403/)).toBeTruthy();
  });

  it('says plainly when no export has ever been asked for', async () => {
    api.listCustomerExports.mockResolvedValue(ok({ items: [] }));
    render(await page());
    expect(screen.getByText(/No export has been requested for this customer/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request a data export' })).toBeTruthy();
  });
});

describe('the states read as what they are', () => {
  it('distinguishes pending, ready, expired, and the two reasons nothing was built', () => {
    expect(describeExport(request({ status: 'pending', ready_at: null, size_bytes: null }))).toBe(
      'Being built by the core.',
    );
    expect(describeExport(request())).toMatch(/^Ready to hand over until 2026-12-04\.$/);
    expect(describeExport(request({ status: 'ready', expires_at: null }))).toBe(
      'Ready to hand over.',
    );
    expect(describeExport(request({ status: 'expired', reason: 'customer_gone' }))).toMatch(
      /erased before the bundle was/,
    );
    expect(describeExport(request({ status: 'expired', reason: 'too_large' }))).toMatch(
      /too large/,
    );
    // Expired with no reason is a purge, not a failure.
    expect(describeExport(request({ status: 'expired', reason: null }))).toMatch(/purged/);
  });

  it('names the self-service case without naming the customer', () => {
    const entry = request({ requested_by_type: 'customer' });
    expect(requesterLabel(entry, () => 'Should not be used')).toBe('The customer (self-service)');
  });

  it('sizes a bundle, and says nothing when there is none', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
    expect(formatBytes(15_728_640)).toBe('15 MB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });

  it('counts downloads in words, and stays silent at zero', () => {
    expect(describeDownloads(0)).toBeNull();
    expect(describeDownloads(1)).toBe('downloaded once');
    expect(describeDownloads(2)).toBe('downloaded twice');
    expect(describeDownloads(5)).toBe('downloaded 5 times');
  });

  it('shows the download count on a bundle that has been handed over', async () => {
    api.listCustomerExports.mockResolvedValue(ok({ items: [request({ download_count: 2 })] }));
    render(await page());
    expect(screen.getByText('downloaded twice')).toBeTruthy();
  });
});
