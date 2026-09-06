import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { updateStoreAction } from '@/app/actions/stores';
import {
  getStore,
  listApiKeys,
  listDomains,
  listLegalEntities,
  listSalesChannels,
} from '@/lib/api/admin';
import type { StoreCreateValues } from '@/lib/forms/schemas';
import { StoreForm } from '../store-form';
import { ApiKeysPanel } from './api-keys-panel';
import { DomainsPanel, SalesChannelsPanel } from './registry-panels';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  paused: 'warning',
  draft: 'neutral',
  archived: 'neutral',
};

/**
 * Store detail: everything `registry` covers for one store — the record itself, its domains, its
 * sales channels and its API keys.
 *
 * The four sub-resources are fetched in parallel and each is allowed to fail on its own: listing
 * API keys needs `store_admin` while reading the store only needs `viewer`, so a `viewer` should
 * still see the store rather than an error page.
 */
export default async function StoreDetailPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  const [store, domains, channels, keys, entities] = await Promise.all([
    getStore(storeId),
    listDomains(storeId),
    listSalesChannels(storeId),
    listApiKeys(storeId),
    listLegalEntities(),
  ]);

  if (!store.ok) {
    return (
      <HqSectionGuard id="stores">
        <RequestErrorPanel status={store.status} error={store.error} />
      </HqSectionGuard>
    );
  }

  const current = store.data;
  const defaultValues: StoreCreateValues = {
    legal_entity_id: current.legal_entity_id,
    code: current.code,
    name: current.name,
    status: current.status,
    default_currency: current.default_currency,
    default_locale: current.default_locale,
    default_country: current.default_country,
    timezone: current.timezone,
  };

  return (
    <HqSectionGuard id="stores">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{current.name}</h1>
          <Badge tone={STATUS_TONE[current.status] ?? 'neutral'}>{current.status}</Badge>
          <span className="text-muted font-mono text-xs">{current.code}</span>
          <Link href="/stores" className="text-accent ml-auto text-sm hover:underline">
            All stores
          </Link>
        </div>

        <Card>
          <CardHeader title="Details" description="Editing needs store_admin on this store." />
          <CardBody>
            <StoreForm
              // Bound, not wrapped: only a server action reference may cross to the client.
              action={updateStoreAction.bind(null, storeId)}
              defaultValues={defaultValues}
              legalEntities={entities.ok ? entities.data.items : []}
              submitLabel="Save changes"
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Domains"
            description="Adding a domain needs owner on organization:hq."
          />
          <CardBody>
            {domains.ok ? (
              <DomainsPanel storeId={storeId} domains={domains.data.items} />
            ) : (
              <RequestErrorPanel status={domains.status} error={domains.error} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Sales channels" />
          <CardBody>
            {channels.ok ? (
              <SalesChannelsPanel storeId={storeId} channels={channels.data.items} />
            ) : (
              <RequestErrorPanel status={channels.status} error={channels.error} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="API keys"
            description="A new key's value is shown once and cannot be retrieved again."
          />
          <CardBody>
            {keys.ok ? (
              <ApiKeysPanel
                storeId={storeId}
                keys={keys.data.items}
                salesChannels={channels.ok ? channels.data.items : []}
              />
            ) : (
              <RequestErrorPanel status={keys.status} error={keys.error} />
            )}
          </CardBody>
        </Card>
      </div>
    </HqSectionGuard>
  );
}
