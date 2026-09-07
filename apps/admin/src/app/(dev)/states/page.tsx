import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
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

export const dynamic = 'force-dynamic';

/**
 * Every state on one page, for eyeballing them side by side.
 *
 * Development only — `notFound()` in production, so it can never be reached on a deployed admin
 * app. It is not a Storybook: the panels here are the same components the real screens render, so
 * this page cannot drift from what users actually see.
 */
export default function StatesPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  const cases: { name: string; note: string; panel: React.ReactNode }[] = [
    {
      name: '401 — session ended',
      note: 'The token was rejected after the middleware let the request through.',
      panel: <UnauthorizedPanel />,
    },
    {
      name: '403 — forbidden, relation known',
      note: 'The contract names the relation and object, so the panel can too.',
      panel: (
        <ForbiddenPanel
          error={{
            code: 'forbidden',
            message: 'requires finance on organization:hq',
            details: { relation: 'finance', object: 'organization:hq' },
          }}
        />
      ),
    },
    {
      name: '403 — forbidden, no details',
      note: 'Still actionable: it says who to ask.',
      panel: <ForbiddenPanel error={{ code: 'forbidden', message: 'no' }} />,
    },
    {
      name: '403 — store outside stores[]',
      note: 'Rendered inside the shell, so the switcher is still there.',
      panel: <StoreForbiddenPanel storeId="00000000-0000-4000-8000-000000000033" />,
    },
    {
      name: '404 — scoped to the store',
      note: 'The API answers "not found in the caller\'s scope", so the panel says where it looked.',
      panel: (
        <NotFoundPanel
          what="This product"
          storeId="00000000-0000-4000-8000-000000000031"
          backHref="/"
          backLabel="All products"
        />
      ),
    },
    {
      name: 'Empty — nothing yet',
      note: 'A call to action, not an apology.',
      panel: (
        <EmptyPanel
          title="No products yet"
          action={
            <Link href="/">
              <Button>Create the first product</Button>
            </Link>
          }
        />
      ),
    },
    {
      name: 'Empty — filter matched nothing',
      note: 'A different problem with a different next action.',
      panel: (
        <EmptyPanel
          title="No products match this filter"
          description="Nothing here matched what you searched for."
          action={<Button variant="secondary">Clear filters</Button>}
        />
      ),
    },
    {
      name: 'No relations at all',
      note: 'Real on day one of onboarding.',
      panel: <NoAccessPanel />,
    },
    {
      name: 'Network — API unreachable',
      note: 'The only state where retrying is reasonable, so the only one with a retry.',
      panel: (
        <RequestErrorPanel
          status={0}
          error={{ code: 'network_error', message: 'connect ECONNREFUSED 127.0.0.1:4011' }}
        />
      ),
    },
    {
      name: '500 — server error',
      note: 'Same panel, different wording.',
      panel: (
        <RequestErrorPanel status={500} error={{ code: 'internal', message: 'Internal error' }} />
      ),
    },
    {
      name: 'Dispatcher — ApiStatePanel(403)',
      note: 'What every screen actually calls; it picks the panel from the status.',
      panel: (
        <ApiStatePanel
          status={403}
          error={{
            code: 'forbidden',
            message: 'requires store_admin on store:brand-a',
            details: { relation: 'store_admin', object: 'store:brand-a' },
          }}
        />
      ),
    },
  ];

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-6 py-10">
      <header>
        <h1 className="text-xl font-semibold">States</h1>
        <p className="text-muted mt-1 text-sm">
          Every panel the admin app can show instead of content. Development only. Each has a
          heading and a next action — that is the rule this page exists to keep honest.
        </p>
      </header>

      {cases.map((entry) => (
        <section key={entry.name} className="space-y-2">
          <h2 className="text-sm font-semibold">{entry.name}</h2>
          <p className="text-muted text-xs">{entry.note}</p>
          {entry.panel}
        </section>
      ))}
    </main>
  );
}
