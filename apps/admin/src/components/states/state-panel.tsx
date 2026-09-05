import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import type { AdminError } from '@/lib/api/admin-client';

/**
 * The seed of the shared 401/403/404/empty/error pattern. Issue #29 grows this into the full set
 * and wires it into the data-table and form primitives; what matters already is the rule it
 * encodes — a refused request renders a panel *in place*, with a heading and a next action, and
 * never a blank page or a thrown error.
 */
export function StatePanel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} {...(description === undefined ? {} : { description })} />
      <CardBody className="space-y-4">
        {children}
        {action}
      </CardBody>
    </Card>
  );
}

/**
 * `403 { code: forbidden, details: { relation, object } }` — say which relation on which object is
 * missing, because "access denied" tells an admin nothing about who to ask.
 */
export function ForbiddenPanel({ error, hint }: { error?: AdminError; hint?: string }) {
  const details = (error?.details ?? {}) as { relation?: unknown; object?: unknown };
  const relation = typeof details.relation === 'string' ? details.relation : null;
  const object = typeof details.object === 'string' ? details.object : null;

  return (
    <StatePanel
      title="You do not have access to this"
      description={
        relation !== null && object !== null
          ? `You need the ${relation} relation on ${object}.`
          : 'Your account does not hold a relation that grants this.'
      }
    >
      {hint !== undefined && <p className="text-muted text-sm">{hint}</p>}
      <p className="text-muted text-sm">
        Ask an organization owner to grant it, then reload this page.
      </p>
    </StatePanel>
  );
}

/** A store that exists but is not in `stores[]`, or a bad id in the URL. */
export function StoreForbiddenPanel({ storeId }: { storeId: string }) {
  return (
    <StatePanel
      title="You do not have access to this store"
      description="Only the stores in your switcher are yours to open."
    >
      <p className="text-muted text-sm">
        Requested store <span className="font-mono">{storeId}</span>.
      </p>
      <p className="text-muted text-sm">
        Pick one of your own stores above, or ask an organization owner for a relation on this one.
      </p>
    </StatePanel>
  );
}

/** An account with no relations at all — real on day one of onboarding. */
export function NoAccessPanel() {
  return (
    <StatePanel
      title="Nothing is assigned to your account yet"
      description="You are signed in, but you hold no relation on the organization or on any store."
    >
      <p className="text-muted text-sm">
        An organization owner can assign one under Roles. Until then there is nothing to show.
      </p>
    </StatePanel>
  );
}

/** Non-403 failures: the mock is down, the API 500s, the network dropped. */
export function RequestErrorPanel({ status, error }: { status: number; error: AdminError }) {
  return (
    <StatePanel
      title={status === 0 ? 'Could not reach the Admin API' : `Admin API returned ${status}`}
      description={error.message}
    >
      <p className="text-muted text-sm">
        In Phase 1 this app talks to the Prism mock — start it with{' '}
        <span className="font-mono">pnpm mock</span> — then reload.
      </p>
    </StatePanel>
  );
}
