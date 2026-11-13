/**
 * The history screens (#870 wave 1 item 3): what `loadActivity` asks the API for, and what the
 * panels render.
 *
 * Beyond "it renders": a refused `listUsers` leaves the history standing with the actor unnamed
 * (actor names need `owner` on `organization:hq`, which a store admin does not have), a calendar
 * day becomes the whole day in the API call, and the CSV link carries the filters on screen.
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/audit',
}));
vi.mock('@/components/shell/section-guard', () => ({
  HqSectionGuard: ({ children }: { children: ReactNode }) => children,
  StoreSectionGuard: ({ children }: { children: ReactNode }) => children,
}));

const SERVICE = '00000000-0000-4000-8000-0000000000ff';
vi.mock('@/lib/roles', () => ({ isServiceAccount: (id: string) => id === SERVICE }));

const api = vi.hoisted(() => ({
  listAuditLog: vi.fn(),
  listUsers: vi.fn(),
  listStores: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const { ActivityPanel, OrderActivityPanel, loadActivity, loadOrderPaymentActivity, activityPage } =
  await (async () => {
    const panel = await import('@/components/audit/activity-panel');
    const order = await import('@/components/audit/order-activity-panel');
    const load = await import('@/lib/audit/load');
    return { ...panel, ...order, ...load };
  })();
const AuditPage = (await import('@/app/(hq)/audit/page')).default;

const STORE = '00000000-0000-4000-8000-000000000031';
const PRODUCT = '30000000-0000-4000-8000-000000000201';
const ADA = '00000000-0000-4000-8000-000000000044';

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number) => ({
  ok: false as const,
  status,
  error: { code: 'forbidden', message: 'Forbidden' },
});

const user = (id: string, name: string) => ({
  id,
  email: `${name.toLowerCase().replace(' ', '.')}@example.test`,
  display_name: name,
  status: 'active' as const,
  last_login_at: null,
});

const auditEntry = (over: Record<string, unknown> = {}) => ({
  id: '90000000-0000-4000-8000-000000000001',
  store_id: STORE,
  actor_id: ADA,
  actor_type: 'staff',
  action: 'product.update',
  entity_type: 'product',
  entity_id: PRODUCT,
  before: { title: 'Classic T' },
  after: { title: 'Classic Tee' },
  request_id: 'req_abc',
  created_at: '2026-11-13T12:00:00.000Z',
  ...over,
});

const pageOf = <T,>(items: T[], total = items.length) => ok({ page: 1, limit: 20, total, items });

beforeEach(() => {
  vi.clearAllMocks();
  api.listStores.mockResolvedValue(pageOf([{ id: STORE, name: 'Brand A', code: 'brand-a' }]));
  api.listUsers.mockResolvedValue(pageOf([user(ADA, 'Ada Lovelace'), user(SERVICE, 'CI bot')]));
});

describe('loadActivity asks for this entity only', () => {
  it('sends the store, the entity and the page, and nothing else', async () => {
    api.listAuditLog.mockResolvedValue(pageOf([auditEntry()]));
    const activity = await loadActivity({
      storeId: STORE,
      entityType: 'product',
      entityId: PRODUCT,
      page: 2,
    });

    expect(api.listAuditLog).toHaveBeenCalledWith({
      store_id: STORE,
      entity_type: 'product',
      entity_id: PRODUCT,
      page: 2,
      limit: 20,
    });
    expect(activity.rows[0]?.actor).toEqual({ name: 'Ada Lovelace', kind: 'staff' });
  });

  it('a refused listUsers leaves the history standing, with the actor unnamed', async () => {
    // `listUsers` is `owner on organization:hq`; a store admin reading a product is refused there.
    api.listUsers.mockResolvedValue(fail(403));
    api.listAuditLog.mockResolvedValue(pageOf([auditEntry()]));

    const activity = await loadActivity({
      storeId: STORE,
      entityType: 'product',
      entityId: PRODUCT,
    });

    expect(activity.error).toBeUndefined();
    expect(activity.rows[0]?.actor).toEqual({
      name: 'Unknown staff (00000000)',
      kind: 'unknown',
    });
  });

  it('a refused audit read becomes an error the panel can show, not an empty list', async () => {
    api.listAuditLog.mockResolvedValue(fail(403));
    const activity = await loadActivity({
      storeId: STORE,
      entityType: 'product',
      entityId: PRODUCT,
    });
    expect(activity.error?.status).toBe(403);
    expect(activity.rows).toEqual([]);
  });

  it('reads `?activity=` defensively', () => {
    expect(activityPage(undefined)).toBe(1);
    expect(activityPage('0')).toBe(1);
    expect(activityPage('abc')).toBe(1);
    expect(activityPage(['2'])).toBe(1);
    expect(activityPage('3')).toBe(3);
  });
});

describe('the entity Activity panel', () => {
  const activityOf = async (entry = auditEntry(), total?: number, page = 1) => {
    api.listAuditLog.mockResolvedValue(pageOf([entry], total));
    return loadActivity({ storeId: STORE, entityType: 'product', entityId: PRODUCT, page });
  };

  it('names the person, the change and the field', async () => {
    render(<ActivityPanel activity={await activityOf()} entityType="product" basePath="/base" />);
    const table = screen.getByRole('table', { name: /activity on this product/i });
    expect(within(table).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(table).getByText('updated · title')).toBeTruthy();
    expect(within(table).getByText('Classic Tee')).toBeTruthy();
  });

  it('labels a service account, and withholds a value nobody reviewed', async () => {
    const activity = await activityOf(
      auditEntry({
        actor_id: SERVICE,
        before: { internal_note: 'old' },
        after: { internal_note: 'new' },
      }),
    );
    render(<ActivityPanel activity={activity} entityType="product" basePath="/base" />);

    expect(screen.getByText('service account')).toBeTruthy();
    expect(screen.getByText(/changed — value not shown/)).toBeTruthy();
    expect(screen.queryByText('new')).toBeNull();
  });

  it('says nothing has happened rather than showing an empty table', () => {
    render(
      <ActivityPanel
        activity={{ rows: [], total: 0, page: 1 }}
        entityType="promotion"
        basePath="/base"
      />,
    );
    expect(screen.getByText(/No recorded changes yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the refusal rather than an empty, reassuring panel', () => {
    render(
      <ActivityPanel
        activity={{
          rows: [],
          total: 0,
          page: 1,
          error: { status: 403, error: { code: 'forbidden', message: 'Forbidden' } },
        }}
        entityType="product"
        basePath="/base"
      />,
    );
    expect(screen.getByText(/Admin API returned 403/)).toBeTruthy();
  });

  it('offers the older page only when there is one', async () => {
    render(
      <ActivityPanel
        activity={await activityOf(auditEntry(), 45, 2)}
        entityType="product"
        basePath="/base"
      />,
    );
    expect(screen.getByRole('link', { name: /Older/ }).getAttribute('href')).toBe(
      '/base?activity=3',
    );
    expect(screen.getByRole('link', { name: /Newer/ }).getAttribute('href')).toBe(
      '/base?activity=1',
    );
  });
});

describe("the order's payment activity", () => {
  it('reads the payments, because an order has no audit rows of its own', async () => {
    api.listAuditLog.mockResolvedValue(
      pageOf([
        auditEntry({
          entity_type: 'payment',
          entity_id: 'p1',
          action: 'payment.capture',
          before: { status: 'authorized' },
          after: { status: 'captured' },
        }),
      ]),
    );

    const activity = await loadOrderPaymentActivity(STORE, ['p1']);
    render(<OrderActivityPanel activity={activity} hasPayments />);

    expect(api.listAuditLog).toHaveBeenCalledWith({
      store_id: STORE,
      entity_type: 'payment',
      entity_id: 'p1',
      limit: 20,
    });
    const table = screen.getByRole('table', { name: /payment activity on this order/i });
    // `payments/capture.ts` writes "ids and amounts only", so the transition itself is shown.
    expect(within(table).getByText('captured · status')).toBeTruthy();
    expect(within(table).getByText('captured')).toBeTruthy();
  });

  it('merges the payments of one order newest-first', async () => {
    api.listAuditLog
      .mockResolvedValueOnce(
        pageOf([auditEntry({ id: 'older', created_at: '2026-11-01T00:00:00.000Z' })]),
      )
      .mockResolvedValueOnce(
        pageOf([auditEntry({ id: 'newer', created_at: '2026-11-12T00:00:00.000Z' })]),
      );
    const activity = await loadOrderPaymentActivity(STORE, ['p1', 'p2']);
    expect(activity.rows.map((row) => row.id)).toEqual(['newer', 'older']);
  });

  it('an order with no payment says so instead of calling the API at all', async () => {
    const activity = await loadOrderPaymentActivity(STORE, []);
    render(<OrderActivityPanel activity={activity} hasPayments={false} />);
    expect(api.listAuditLog).not.toHaveBeenCalled();
    expect(screen.getByText(/No payment on this order yet/)).toBeTruthy();
  });
});

describe('HQ · Audit', () => {
  const searchParams = (params: Record<string, string> = {}) => Promise.resolve(params);

  it('asks for the whole of each calendar day the reader picked', async () => {
    api.listAuditLog.mockResolvedValue(pageOf([auditEntry()]));

    render(
      await AuditPage({
        searchParams: searchParams({
          from: '2026-11-01',
          to: '2026-11-13',
          entity_type: 'product',
        }),
      }),
    );

    expect(api.listAuditLog).toHaveBeenCalledWith({
      page: 1,
      limit: 50,
      sort: 'created_at',
      order: 'desc',
      entity_type: 'product',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-13T23:59:59.999Z',
    });
  });

  it('drops a filter the API would refuse rather than showing an error', async () => {
    api.listAuditLog.mockResolvedValue(pageOf([auditEntry()]));
    render(await AuditPage({ searchParams: searchParams({ store_id: 'not-a-uuid' }) }));
    expect(api.listAuditLog).toHaveBeenCalledWith(
      expect.not.objectContaining({ store_id: expect.anything() }),
    );
  });

  it('shows the store on each row and exports the same filters', async () => {
    api.listAuditLog.mockResolvedValue(pageOf([auditEntry()]));
    render(await AuditPage({ searchParams: searchParams({ entity_type: 'product' }) }));

    const table = screen.getByRole('table', { name: 'Audit entries' });
    expect(within(table).getByText('Brand A (brand-a)')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Export this page as CSV/ }).getAttribute('href')).toBe(
      '/audit/export?entity_type=product',
    );
  });

  it('forwards the API refusal instead of rendering an empty, reassuring table', async () => {
    api.listAuditLog.mockResolvedValue(fail(403));
    render(await AuditPage({ searchParams: searchParams() }));
    expect(screen.queryByRole('table', { name: 'Audit entries' })).toBeNull();
    expect(screen.getByText(/Admin API returned 403/)).toBeTruthy();
  });
});
