import { MetricsDashboard } from '@/app/(hq)/bi/_components/metrics-dashboard';
import { windowFrom, type StoreRef } from '@/app/(hq)/bi/_lib/report';
import { expandOrganizationRelations } from '@/lib/nav/relations';
import { loadPrincipal } from '@/lib/principal';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Store BI (#604, window 12): the metrics dashboard narrowed to this store. The store layout already refuses a store
 * outside the principal's list; the metrics API scopes every statement on top (a store outside the scope is a 403,
 * never empty rows), so a store admin sees exactly its own store. Finance figures only for finance principals.
 */
export default async function StoreBiPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Params>;
}) {
  const [{ storeId }, raw, principal] = await Promise.all([params, searchParams, loadPrincipal()]);
  const stores: StoreRef[] = principal.ok
    ? principal.data.stores.map((s) => ({ store_id: s.store_id, code: s.code }))
    : [];
  const finance =
    principal.ok &&
    expandOrganizationRelations(principal.data.organization_relations).has('finance');
  return (
    <MetricsDashboard
      window={windowFrom({ from: one(raw.from), to: one(raw.to) })}
      currencyParam={one(raw.currency)}
      finance={finance}
      stores={stores}
      storeId={storeId}
      base={`/${storeId}/bi`}
    />
  );
}
