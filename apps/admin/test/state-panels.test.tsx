import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiStatePanel,
  EmptyPanel,
  ForbiddenPanel,
  NoAccessPanel,
  NotFoundPanel,
  RequestErrorPanel,
  StoreForbiddenPanel,
  UnauthorizedPanel,
} from '@/components/states/state-panel';
import { Button } from '@/components/ui/button';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/stores',
}));

const FORBIDDEN = {
  code: 'forbidden',
  message: 'requires finance on organization:hq',
  details: { relation: 'finance', object: 'organization:hq' },
};

/**
 * "No console errors in any state" is one of #29's acceptance criteria, so it is asserted rather
 * than assumed — a React key warning or a hydration complaint would otherwise pass unnoticed.
 */
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

/** Every panel must be identifiable and must offer something to do next. */
function expectHeadingAndNextAction(container: HTMLElement) {
  const heading = within(container).getAllByRole('heading')[0];
  expect(heading).toBeInTheDocument();
  expect(heading?.textContent?.trim()).not.toEqual('');

  const actions = [
    ...within(container).queryAllByRole('button'),
    ...within(container).queryAllByRole('link'),
  ];
  const prose = within(container).queryAllByText(/ask|sign in|reload|retry|try again|owner|pick/i);
  expect(actions.length + prose.length).toBeGreaterThan(0);
}

describe('every state has a heading and a next action', () => {
  it('401 offers signing in again, not a retry that would fail identically', () => {
    const { container } = render(<UnauthorizedPanel />);
    expect(screen.getByRole('heading', { name: /session has ended/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sign in again/ })).toHaveAttribute(
      'href',
      '/api/auth/login',
    );
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expectHeadingAndNextAction(container);
  });

  it('403 names the relation and the object', () => {
    const { container } = render(<ForbiddenPanel error={FORBIDDEN} />);
    expect(
      screen.getByText(/You need the finance relation on organization:hq/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ask an organization owner/)).toBeInTheDocument();
    expectHeadingAndNextAction(container);
  });

  it('403 without details is still actionable', () => {
    const { container } = render(<ForbiddenPanel error={{ code: 'forbidden', message: 'no' }} />);
    expect(screen.getByText(/does not hold a relation/)).toBeInTheDocument();
    expect(screen.getByText(/Roles, in the HQ view/)).toBeInTheDocument();
    expectHeadingAndNextAction(container);
  });

  it('a forbidden store names the id and points at the switcher', () => {
    const { container } = render(<StoreForbiddenPanel storeId="store-c" />);
    expect(screen.getByText('store-c')).toBeInTheDocument();
    expect(screen.getByText(/Pick one of your own stores/)).toBeInTheDocument();
    expectHeadingAndNextAction(container);
  });

  it('404 says which store was searched, because the API scopes it', () => {
    const { container } = render(
      <NotFoundPanel
        what="This product"
        storeId="store-a"
        backHref="/a/catalog"
        backLabel="All products"
      />,
    );
    expect(screen.getByRole('heading', { name: 'This product was not found' })).toBeInTheDocument();
    expect(screen.getByText(/Searched in store/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All products' })).toHaveAttribute(
      'href',
      '/a/catalog',
    );
    expectHeadingAndNextAction(container);
  });

  it('404 without a store does not claim one was searched', () => {
    render(<NotFoundPanel what="This page" backHref="/" />);
    expect(screen.queryByText(/Searched in store/)).toBeNull();
    expect(screen.getByText(/never have existed/)).toBeInTheDocument();
  });

  it('an empty list gets a call to action, not an apology', () => {
    const { container } = render(
      <EmptyPanel title="No products yet" action={<Button>Create the first product</Button>} />,
    );
    expect(screen.getByRole('button', { name: 'Create the first product' })).toBeInTheDocument();
    expectHeadingAndNextAction(container);
  });

  it('an account with no relations is explained rather than blanked', () => {
    const { container } = render(<NoAccessPanel />);
    expect(
      screen.getByText(/An organization owner can assign one under Roles/),
    ).toBeInTheDocument();
    expectHeadingAndNextAction(container);
  });

  it('an unreachable API offers a retry and says how to start the mock', () => {
    const { container } = render(
      <RequestErrorPanel
        status={0}
        error={{ code: 'network_error', message: 'connect ECONNREFUSED' }}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /Could not reach the Admin API/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByText(/pnpm mock/)).toBeInTheDocument();
    expectHeadingAndNextAction(container);
  });

  it('a 500 uses the same panel with different wording', () => {
    render(<RequestErrorPanel status={500} error={{ code: 'internal', message: 'boom' }} />);
    expect(screen.getByRole('heading', { name: 'Admin API returned 500' })).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('ApiStatePanel dispatches on status', () => {
  const error = { code: 'x', message: 'x' };

  it('401 → sign in again', () => {
    render(<ApiStatePanel status={401} error={error} />);
    expect(screen.getByRole('link', { name: /Sign in again/ })).toBeInTheDocument();
  });

  it('403 → the relation panel', () => {
    render(<ApiStatePanel status={403} error={FORBIDDEN} />);
    expect(screen.getByText(/You need the finance relation/)).toBeInTheDocument();
  });

  it('404 → not found, scoped when a store is given', () => {
    render(<ApiStatePanel status={404} error={error} what="This store" storeId="store-a" />);
    expect(screen.getByRole('heading', { name: 'This store was not found' })).toBeInTheDocument();
    expect(screen.getByText(/Searched in store/)).toBeInTheDocument();
  });

  it('anything else → the retry panel', () => {
    render(<ApiStatePanel status={503} error={{ code: 'internal', message: 'unavailable' }} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a 0 status is the unreachable wording, not "returned 0"', () => {
    render(<ApiStatePanel status={0} error={{ code: 'network_error', message: 'down' }} />);
    expect(screen.getByRole('heading', { name: /Could not reach/ })).toBeInTheDocument();
  });
});
