import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from './app-shell';
import {
  ApiStatePanel,
  ForbiddenPanel,
  NoAccessPanel,
  StoreForbiddenPanel,
} from '@/components/states/state-panel';
import {
  allowedStores,
  canAccessStore,
  hasHqView,
  hqNavItems,
  resolveSelectedStoreId,
  storeNavItems,
} from '@/lib/nav/navigation';
import { readRememberedStoreId } from '@/lib/nav/selected-store';
import { loadPrincipal } from '@/lib/principal';

function BareFrame({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-lg px-6 py-16">{children}</main>;
}

/**
 * The gate every page renders behind: loads the principal once, decides the two nav lists, and
 * substitutes a state panel for the page whenever the principal may not be there.
 *
 * A `storeId` puts the shell in store view. The check is not "is this section hidden" but "is this
 * store in `stores[]`" — a direct URL to someone else's store gets the 403 panel with the switcher
 * still on screen, so the user can get back to their own work rather than hitting a dead end.
 */
export async function Shell({
  storeId,
  requireHq = false,
  children,
}: {
  storeId?: string;
  requireHq?: boolean;
  children: ReactNode;
}) {
  const result = await loadPrincipal();

  if (!result.ok) {
    if (result.status === 401) {
      // The token was rejected after the middleware let the request through: start over.
      redirect('/api/auth/login');
    }
    return (
      <BareFrame>
        <ApiStatePanel status={result.status} error={result.error} what="Your account" />
      </BareFrame>
    );
  }

  const principal = result.data;
  const stores = allowedStores(principal);
  const remembered = await readRememberedStoreId();
  const selectedStoreId = storeId ?? resolveSelectedStoreId(principal, remembered);

  if (!hasHqView(principal) && stores.length === 0) {
    return (
      <BareFrame>
        <NoAccessPanel />
      </BareFrame>
    );
  }

  const storeAllowed = selectedStoreId !== null && canAccessStore(principal, selectedStoreId);

  const body =
    storeId !== undefined && !storeAllowed ? (
      <StoreForbiddenPanel storeId={storeId} />
    ) : requireHq && !hasHqView(principal) ? (
      <ForbiddenPanel hint="This is an HQ section. Your relations are on stores only." />
    ) : (
      children
    );

  return (
    <AppShell
      principal={principal}
      hqItems={hqNavItems(principal)}
      storeItems={
        storeAllowed && selectedStoreId !== null ? storeNavItems(principal, selectedStoreId) : []
      }
      stores={stores}
      selectedStoreId={storeAllowed ? selectedStoreId : null}
    >
      {body}
    </AppShell>
  );
}
