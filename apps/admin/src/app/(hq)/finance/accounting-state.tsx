import Link from 'next/link';
import { ForbiddenPanel, NotFoundPanel, StatePanel } from '@/components/states/state-panel';
import { Button } from '@/components/ui/button';
import type { AdminError } from '@/lib/api/admin-client';

/**
 * A failed Accounting API read on HQ › Finance (#851, #853 review). `ApiStatePanel` speaks for the
 * Admin API ("Could not reach the Admin API", the Phase 1 `pnpm mock` line) and drops `hint` outside
 * 403, so a down or unconfigured accounting service read as an Admin API problem. This one names the
 * accounting service and the next step for each failure; 403 and 404 keep the shared panels.
 */
export function AccountingStatePanel({
  status,
  error,
  what,
  backHref,
  backLabel,
}: {
  status: number;
  error: AdminError;
  what: string;
  backHref?: string;
  backLabel?: string;
}) {
  if (status === 403) {
    return (
      <ForbiddenPanel
        error={error}
        hint="HQ › Finance needs finance on organization:hq (owner includes it). The accounting service checks the same relation."
      />
    );
  }
  if (status === 404) {
    return (
      <NotFoundPanel
        what={what}
        {...(backHref === undefined ? {} : { backHref })}
        {...(backLabel === undefined ? {} : { backLabel })}
      />
    );
  }
  if (error.code === 'not_configured') {
    return (
      <StatePanel
        title="The accounting service is not configured"
        description={`${what} cannot be shown: this admin has no ACCOUNTING_API_URL.`}
      >
        <p className="text-muted text-sm">
          Set <span className="font-mono">ACCOUNTING_API_URL</span> to the accounting service
          (apps/accounting) for this admin and restart it. Until then nothing here is shown — an
          empty table would read as empty books.
        </p>
      </StatePanel>
    );
  }
  if (status === 401) {
    return (
      <StatePanel
        title="The accounting service did not accept this session"
        description={`${what} cannot be shown: the accounting service refused the sign-in token.`}
        action={
          <Link href="/api/auth/login">
            <Button>Sign in again</Button>
          </Link>
        }
      >
        <p className="text-muted text-sm">
          If signing in again does not help, the accounting service and this admin are not set up
          for the same staff realm (its Keycloak URL or realm differs).
        </p>
      </StatePanel>
    );
  }
  if (status === 0) {
    return (
      <StatePanel
        title="Could not reach the accounting service"
        description={`${what} cannot be shown: no answer from the accounting service.`}
      >
        <p className="text-muted text-sm">
          Check that apps/accounting is running and that{' '}
          <span className="font-mono">ACCOUNTING_API_URL</span> points at it, then reload. Nothing
          here is shown meanwhile — an empty table would read as empty books.
        </p>
      </StatePanel>
    );
  }
  return (
    <StatePanel
      title={
        status >= 500
          ? `The accounting service answered ${status}`
          : `The accounting service refused the request (${status})`
      }
      description={`${what} cannot be shown. ${error.message}`}
    >
      <p className="text-muted text-sm">
        {status >= 500
          ? 'Usually temporary (the service or its permission check is unavailable): reload in a moment.'
          : 'This is a request the admin should not have sent; please report it with the time.'}{' '}
        <span className="font-mono text-xs">{error.code}</span>
      </p>
    </StatePanel>
  );
}
