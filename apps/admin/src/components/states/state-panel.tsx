import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import type { AdminError } from '@/lib/api/admin-client';
import { RetryButton } from './retry-button';

/**
 * The one pattern for every way a screen can fail to show what was asked for.
 *
 * Two rules hold across all of them:
 *
 * 1. **A refusal renders in place.** Never a blank page, never a thrown error — the panel appears
 *    where the content would have been, with the surrounding shell and navigation intact, so the
 *    user can go somewhere else instead of hitting a dead end.
 * 2. **Every panel has a heading and a next action.** "Access denied" tells an administrator
 *    nothing; "you need `finance` on `organization:hq`, ask an owner" tells them who to ask.
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

function detail(error: AdminError | undefined, key: string): string | null {
  const details = error?.details as Record<string, unknown> | undefined;
  const value = details?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * `401` — the token was rejected after the middleware let the request through (it expired mid-flight,
 * or the realm revoked the session). Signing in again is the only thing that helps, so that is the
 * action rather than a retry that would fail identically.
 */
export function UnauthorizedPanel() {
  return (
    <StatePanel
      title="Your session has ended"
      description="The Admin API no longer accepts this session."
      action={
        <Link href="/api/auth/login">
          <Button>Sign in again</Button>
        </Link>
      }
    >
      <p className="text-muted text-sm">Nothing was lost — signing in again returns you here.</p>
    </StatePanel>
  );
}

/**
 * The contract's `Forbidden` body for a relation the app already knows is missing — the section
 * guards and any page that gates on a relation the section itself does not (pick lists need
 * `operations`) build it here, so the panel reads one shape from one place.
 */
export function requiresRelation(relation: string, object: string): AdminError {
  return {
    code: 'forbidden',
    message: `requires ${relation} on ${object}`,
    details: { relation, object },
  };
}

/**
 * `403 { code: forbidden, details: { relation, object } }` — name the relation and the object, so
 * the reader knows exactly what to ask an owner for.
 */
export function ForbiddenPanel({ error, hint }: { error?: AdminError; hint?: string }) {
  const relation = detail(error, 'relation');
  const object = detail(error, 'object');
  const known = relation !== null && object !== null;

  return (
    <StatePanel
      title="You do not have access to this"
      description={
        known
          ? `You need the ${relation} relation on ${object}.`
          : 'Your account does not hold a relation that grants this.'
      }
    >
      {hint !== undefined && <p className="text-muted text-sm">{hint}</p>}
      <p className="text-muted text-sm">
        Ask an organization owner to grant it{known ? '' : ' — Roles, in the HQ view'}, then reload
        this page.
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

/**
 * `404` — scoped to the current store on purpose. The Admin API answers "not found in the caller's
 * scope", so a missing product may equally be a product that belongs to a store you cannot see; the
 * panel says which store was searched rather than implying the thing does not exist anywhere.
 */
export function NotFoundPanel({
  what = 'This',
  storeId,
  backHref,
  backLabel,
}: {
  what?: string;
  storeId?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <StatePanel
      title={`${what} was not found`}
      description={
        storeId === undefined
          ? 'It may have been archived, or it may never have existed.'
          : 'It may have been archived, or it may belong to a store you cannot see.'
      }
      action={
        backHref === undefined ? undefined : (
          <Link href={backHref}>
            <Button variant="secondary">{backLabel ?? 'Go back'}</Button>
          </Link>
        )
      }
    >
      {storeId !== undefined && (
        <p className="text-muted text-sm">
          Searched in store <span className="font-mono">{storeId}</span>.
        </p>
      )}
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

/**
 * An empty list. Distinct from an error, and distinct again from "your filter matched nothing" —
 * an empty catalog wants a "create your first product" button, a filter that matched nothing wants
 * the filter cleared.
 */
export function EmptyPanel({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <StatePanel
      title={title}
      {...(description === undefined ? {} : { description })}
      {...(action === undefined ? {} : { action })}
    />
  );
}

/**
 * Network failure or `5xx` — the one case where trying again is genuinely reasonable, so it is the
 * only panel with a retry.
 */
export function RequestErrorPanel({ status, error }: { status: number; error: AdminError }) {
  const unreachable = status === 0;
  return (
    <StatePanel
      title={unreachable ? 'Could not reach the Admin API' : `Admin API returned ${status}`}
      description={error.message}
      action={<RetryButton />}
    >
      <p className="text-muted text-sm">
        {unreachable
          ? 'In Phase 1 this app talks to the Prism mock — start it with `pnpm mock`, then retry.'
          : 'This is usually temporary. If it keeps happening, the API is the place to look.'}
      </p>
    </StatePanel>
  );
}

/**
 * The single entry point: hand it any failed `ApiResult` and it picks the right panel.
 *
 * Screens should call this rather than branching on status themselves — that is what keeps the
 * pattern one pattern.
 */
export function ApiStatePanel({
  status,
  error,
  what,
  storeId,
  backHref,
  backLabel,
  hint,
}: {
  status: number;
  error: AdminError;
  what?: string;
  storeId?: string;
  backHref?: string;
  backLabel?: string;
  hint?: string;
}) {
  if (status === 401) return <UnauthorizedPanel />;
  if (status === 403) {
    return <ForbiddenPanel error={error} {...(hint === undefined ? {} : { hint })} />;
  }
  if (status === 404) {
    return (
      <NotFoundPanel
        {...(what === undefined ? {} : { what })}
        {...(storeId === undefined ? {} : { storeId })}
        {...(backHref === undefined ? {} : { backHref })}
        {...(backLabel === undefined ? {} : { backLabel })}
      />
    );
  }
  return <RequestErrorPanel status={status} error={error} />;
}
