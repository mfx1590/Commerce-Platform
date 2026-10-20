import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RolesPage from '@/app/(hq)/roles/page';
import { AssignRoleForm, InviteUserForm } from '@/app/(hq)/roles/role-forms';
import { SEED, type PrincipalKey } from './fixtures/principals';
import type * as SectionGuard from '@/components/shell/section-guard';

vi.mock('server-only', () => ({}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/roles',
}));
const actions = vi.hoisted(() => ({
  inviteUserAction: vi.fn(),
  assignRoleAction: vi.fn(),
  revokeRoleAction: vi.fn(),
}));
vi.mock('@/app/actions/roles', () => actions);
// An async server component cannot render nested in RTL; the page tests pass through it and the
// guard itself is called directly below (and pinned per role in test/role-access.test.ts).
vi.mock('@/components/shell/section-guard', () => ({
  HqSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
const principalOf = vi.hoisted(() => ({ current: 'owner' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));
const api = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listStores: vi.fn(),
  listUserRoles: vi.fn(),
  listAuditLog: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const USER = '00000000-0000-4000-8000-000000000044';
const ORG = '00000000-0000-4000-8000-000000000001';
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const stores = [{ id: SEED.stores.brandA, label: 'Brand A (brand-a)' }];

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'owner';
  api.listUsers.mockResolvedValue(
    ok({
      items: [
        {
          id: USER,
          email: 'store-admin@example.com',
          display_name: 'Sam StoreAdmin',
          status: 'active',
          last_login_at: '2026-10-08T09:00:00Z',
        },
      ],
      page: { page: 1, limit: 20, total: 1 },
    }),
  );
  api.listStores.mockResolvedValue(
    ok({
      items: [{ id: SEED.stores.brandA, code: 'brand-a', name: 'Brand A' }],
      page: { page: 1, limit: 100, total: 1 },
    }),
  );
  api.listUserRoles.mockResolvedValue(
    ok({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000071',
          relation: 'store_admin',
          object_type: 'store',
          object_id: SEED.stores.brandA,
          created_at: '2026-09-04T00:00:00Z',
        },
      ],
    }),
  );
  api.listAuditLog.mockResolvedValue(
    ok({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000081',
          store_id: SEED.stores.brandA,
          actor_id: USER,
          actor_type: 'staff',
          action: 'product.published',
          entity_type: 'product',
          entity_id: '00000000-0000-4000-8000-000000000091',
          before: { title: 'secret-before' },
          after: null,
          request_id: null,
          created_at: '2026-10-07T12:00:00Z',
        },
      ],
      page: { page: 1, limit: 20, total: 1 },
    }),
  );
});

async function renderPage(search: Record<string, string> = {}) {
  render(await RolesPage({ searchParams: Promise.resolve(search) }));
}

describe('the roles screen', () => {
  it.each(['storeAdmin', 'finance'] as const)(
    '%s gets the 403 panel naming owner on hq',
    async (role) => {
      principalOf.current = role;
      const { HqSectionGuard } = await vi.importActual<typeof SectionGuard>(
        '@/components/shell/section-guard',
      );
      render(await HqSectionGuard({ id: 'roles', children: <p>the roles screen</p> }));
      expect(screen.queryByText('the roles screen')).toBeNull();
      expect(document.body).toHaveTextContent(/You need the owner relation on organization:hq/);
    },
  );

  it('owner passes the real guard', async () => {
    const { HqSectionGuard } = await vi.importActual<typeof SectionGuard>(
      '@/components/shell/section-guard',
    );
    render(await HqSectionGuard({ id: 'roles', children: <p>the roles screen</p> }));
    expect(screen.getByText('the roles screen')).toBeInTheDocument();
  });

  it('owner sees the users and the invite form', async () => {
    await renderPage();
    const table = screen.getByRole('table', { name: 'Staff users' });
    expect(within(table).getByText('Sam StoreAdmin')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Invite a staff user' })).toBeInTheDocument();
    expect(api.listUserRoles).not.toHaveBeenCalled();
  });

  it('managing a user lists their relations with Revoke, and their audit entries per store with actor_id', async () => {
    await renderPage({ user: USER });
    const relations = screen.getByRole('list', { name: 'Relations' });
    expect(within(relations).getByText('Brand A (brand-a)')).toBeInTheDocument();
    expect(
      within(relations).getByRole('button', { name: 'Revoke store_admin on Brand A (brand-a)' }),
    ).toBeInTheDocument();
    expect(api.listAuditLog).toHaveBeenCalledWith({
      actor_id: USER,
      store_id: SEED.stores.brandA,
      limit: 20,
    });
    expect(screen.getByText('product.published')).toBeInTheDocument();
    // The before/after bodies are never rendered.
    expect(document.body.innerHTML).not.toContain('secret-before');
  });

  it('a user id that is not a uuid selects nobody', async () => {
    await renderPage({ user: '../x' });
    expect(api.listUserRoles).not.toHaveBeenCalled();
  });
});

describe('invite', () => {
  it('offers only grantable pairs: finance on the organization, never on a store', async () => {
    const user = userEvent.setup();
    render(<InviteUserForm organizationId={ORG} stores={stores} />);
    await user.selectOptions(screen.getByLabelText('Initial relation on'), 'store');
    let options = within(screen.getByLabelText('Relation'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).not.toContain('finance');
    await user.selectOptions(screen.getByLabelText('Initial relation on'), 'organization');
    options = within(screen.getByLabelText('Relation'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toContain('finance');
  });

  it('sends the person and the initial relation on the organization with its id', async () => {
    const user = userEvent.setup();
    actions.inviteUserAction.mockResolvedValue({
      status: 'success',
      data: {
        user: { id: USER, email: 'new@example.com' },
        assignment: { id: 'a' },
        assignmentError: null,
      },
    });
    render(<InviteUserForm organizationId={ORG} stores={stores} />);
    await user.type(screen.getByLabelText(/^Email/), 'new@example.com');
    await user.type(screen.getByLabelText(/^Display name/), 'New Person');
    await user.selectOptions(screen.getByLabelText('Initial relation on'), 'organization');
    await user.selectOptions(screen.getByLabelText('Relation'), 'finance');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(actions.inviteUserAction).toHaveBeenCalledWith({
      email: 'new@example.com',
      display_name: 'New Person',
      initial: { relation: 'finance', object_type: 'organization', object_id: ORG },
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      /Invited new@example.com.*Keycloak/,
    );
  });

  it('a taken email (409) shows under the email field', async () => {
    const user = userEvent.setup();
    actions.inviteUserAction.mockResolvedValue({
      status: 'error',
      fieldErrors: { email: 'A staff user with this email already exists.' },
      formError: null,
    });
    render(<InviteUserForm organizationId={ORG} stores={stores} />);
    await user.type(screen.getByLabelText(/^Email/), 'store-admin@example.com');
    await user.type(screen.getByLabelText(/^Display name/), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(
      await screen.findByText('A staff user with this email already exists.'),
    ).toBeInTheDocument();
  });

  it('invited but the initial grant failed: said, with the user shown', async () => {
    const user = userEvent.setup();
    actions.inviteUserAction.mockResolvedValue({
      status: 'success',
      data: {
        user: { id: USER, email: 'new@example.com' },
        assignment: null,
        assignmentError: 'Invited, but the initial relation was not granted: nope',
      },
    });
    render(<InviteUserForm organizationId={ORG} stores={stores} />);
    await user.type(screen.getByLabelText(/^Email/), 'new@example.com');
    await user.type(screen.getByLabelText(/^Display name/), 'New Person');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Invited new@example.com');
    expect(status).toHaveTextContent('Invited, but the initial relation was not granted: nope');
  });
});

describe('assign and revoke', () => {
  it('assign sends the relation on the chosen store', async () => {
    const user = userEvent.setup();
    actions.assignRoleAction.mockResolvedValue({ status: 'success', data: { id: 'a' } });
    render(<AssignRoleForm userId={USER} organizationId={ORG} stores={stores} />);
    await user.selectOptions(screen.getByLabelText('Relation'), 'support');
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    expect(actions.assignRoleAction).toHaveBeenCalledWith(USER, {
      relation: 'support',
      object_type: 'store',
      object_id: SEED.stores.brandA,
    });
  });

  it('revoke asks first; the confirmation sends', async () => {
    const user = userEvent.setup();
    actions.revokeRoleAction.mockResolvedValue({ status: 'success', data: null });
    await renderPage({ user: USER });
    await user.click(screen.getByRole('button', { name: /^Revoke store_admin/ }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/ends the person’s current sessions/);
    expect(actions.revokeRoleAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, revoke' }));
    expect(actions.revokeRoleAction).toHaveBeenCalledWith(
      USER,
      '00000000-0000-4000-8000-000000000071',
    );
  });
});
