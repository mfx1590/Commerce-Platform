import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getStore, getStoreReadiness } from '@/lib/api/admin';
import { loadPrincipal } from '@/lib/principal';
import { mayPerform } from '@/lib/settings';
import { mayManageShippingOptions } from '@/lib/shipping-options';
import { mayManageTaxRates } from '@/lib/tax-rates';
import { ActivatePanel } from './activate-panel';
import { CanSellBox } from './can-sell';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The readiness panel after onboarding (#428 B): the store's status and Activate. */
export default async function ReadinessPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const valid = UUID.test(storeId);
  const [store, readiness, principal] = await Promise.all([
    valid ? getStore(storeId) : Promise.resolve(null),
    // #830/#839: what activation would refuse now, and whether the store can sell. A failed read
    // only hides the box and the pre-filled list; Activate still asks the core.
    valid ? getStoreReadiness(storeId) : Promise.resolve(null),
    loadPrincipal(),
  ]);
  const ready = readiness?.ok === true ? readiness.data : null;
  // The panel's inline creates are offered only to whoever may make them (a convenience: each
  // action refuses server-side below store_admin anyway).
  const canCreateTax = principal.ok && mayManageTaxRates(principal.data, storeId);
  const canCreateShipping = principal.ok && mayManageShippingOptions(principal.data, storeId);
  const canEditPayment = principal.ok && mayPerform(principal.data, 'updateStore', storeId);

  return (
    <HqSectionGuard id="onboarding">
      <Card>
        <CardHeader
          title="Readiness"
          description="A store goes live once its legal entity, locale, currency, primary domain, publishable key and permission object exist, every market country has a tax rate and an active shipping option in the store currency, and customers have a way to pay."
          action={
            <Link href="/stores" className="text-accent text-sm hover:underline">
              All stores
            </Link>
          }
        />
        <CardBody className="space-y-4">
          {store === null ? (
            <p className="text-muted text-sm">That is not a store id.</p>
          ) : !store.ok ? (
            <ApiStatePanel status={store.status} error={store.error} what="This store" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">{store.data.name}</h2>
                <span className="text-muted font-mono text-xs">{store.data.code}</span>
                <Badge tone={store.data.status === 'active' ? 'success' : 'neutral'}>
                  {store.data.status}
                </Badge>
              </div>
              <ActivatePanel
                storeId={store.data.id}
                status={store.data.status}
                defaultCurrency={store.data.default_currency}
                canCreateTax={canCreateTax}
                canCreateShipping={canCreateShipping}
                canEditPayment={canEditPayment}
                updatedAt={store.data.updated_at}
                readiness={ready}
              />
              {ready !== null && <CanSellBox storeId={store.data.id} readiness={ready} />}
            </>
          )}
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
