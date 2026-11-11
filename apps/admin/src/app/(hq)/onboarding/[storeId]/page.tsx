import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getStore } from '@/lib/api/admin';
import { loadPrincipal } from '@/lib/principal';
import { mayManageShippingOptions } from '@/lib/shipping-options';
import { mayManageTaxRates } from '@/lib/tax-rates';
import { ActivatePanel } from './activate-panel';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The readiness panel after onboarding (#428 B): the store's status and Activate. */
export default async function ReadinessPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const [store, principal] = await Promise.all([
    UUID.test(storeId) ? getStore(storeId) : Promise.resolve(null),
    loadPrincipal(),
  ]);
  // The panel's inline creates are offered only to whoever may make them (a convenience: each
  // action refuses server-side below store_admin anyway).
  const canCreateTax = principal.ok && mayManageTaxRates(principal.data, storeId);
  const canCreateShipping = principal.ok && mayManageShippingOptions(principal.data, storeId);

  return (
    <HqSectionGuard id="onboarding">
      <Card>
        <CardHeader
          title="Readiness"
          description="A store goes live once its legal entity, locale, currency, primary domain, publishable key and permission object exist, and every market country has a tax rate and an active shipping option in the store currency."
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
              />
            </>
          )}
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
