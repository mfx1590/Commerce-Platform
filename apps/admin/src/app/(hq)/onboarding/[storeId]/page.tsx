import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getStore } from '@/lib/api/admin';
import { ActivatePanel } from './activate-panel';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The readiness panel after onboarding (#428 B): the store's status and Activate. */
export default async function ReadinessPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const store = UUID.test(storeId) ? await getStore(storeId) : null;

  return (
    <HqSectionGuard id="onboarding">
      <Card>
        <CardHeader
          title="Readiness"
          description="A store goes live once its legal entity, locale, currency, primary domain, publishable key and permission object exist."
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
              <ActivatePanel storeId={store.data.id} status={store.data.status} />
            </>
          )}
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
