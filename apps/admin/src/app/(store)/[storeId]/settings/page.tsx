import { CreateApiKey } from '@/components/registry/api-key-create';
import { AddDomainForm } from '@/components/registry/domain-form';
import { ApiKeyList, DomainList, SalesChannelList } from '@/components/registry/lists';
import { CreateSalesChannelForm } from '@/components/registry/sales-channel-form';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import {
  ApiStatePanel,
  ForbiddenPanel,
  RequestErrorPanel,
  requiresRelation,
} from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getStore, listApiKeys, listDomains, listSalesChannels } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { loadPrincipal } from '@/lib/principal';
import {
  forChannelOptions,
  forStoreSettings,
  settingsPermissions,
  type SettingsPermissions,
} from '@/lib/settings';
import { GeneralSettingsForm } from './general-form';

export const dynamic = 'force-dynamic';

const NONE: SettingsPermissions = {
  canEditStore: false,
  canAddDomain: false,
  canMovePrimary: false,
  canCreateChannel: false,
  canManageKeys: false,
};

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  paused: 'warning',
  draft: 'neutral',
  archived: 'neutral',
};

/** A relation the reader lacks for one form on this page, named rather than hidden. */
function Needs({ relation, object, to }: { relation: string; object: string; to: string }) {
  return (
    <p className="text-muted border-line border-t pt-3 text-sm">
      {to} needs <span className="font-mono">{relation}</span> on{' '}
      <span className="font-mono">{object}</span>.
    </p>
  );
}

function ReadOnlyGeneral({ store }: { store: AdminComponents['Store'] }) {
  const rows: [string, string][] = [
    ['Name', store.name],
    ['Default currency', store.default_currency],
    ['Default locale', store.default_locale],
    ['Default country', store.default_country],
    ['Timezone', store.timezone],
    ['Enabled currencies', store.currencies.join(', ')],
    ['Enabled locales', store.locales.join(', ')],
  ];
  return (
    <dl className="grid max-w-3xl gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Store settings (#117): General, Domains, Sales channels, API keys.
 *
 * store_staff reads everything except the API keys (listing them is store_admin); each form and
 * button is offered only to the relation its operation needs, and otherwise names that relation.
 * The server actions refuse the same way before calling the API (`src/lib/settings/guard.ts`).
 * General includes the enabled currency/locale sets; Domains moves the primary (owner on hq); API
 * keys revoke after a confirmation, never the last live publishable key (Admin API 0.4.8, #279).
 *
 * Lists render here on the server; the client forms take ids, options and six scalars.
 */
export default async function SettingsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const principal = await loadPrincipal();
  const can = principal.ok ? settingsPermissions(principal.data, storeId) : NONE;
  const storeObject = `store:${storeId}`;

  const [store, domains, channels, keys] = await Promise.all([
    getStore(storeId),
    listDomains(storeId),
    listSalesChannels(storeId),
    // Below store_admin the list is a certain 403; do not ask.
    can.canManageKeys ? listApiKeys(storeId) : Promise.resolve(null),
  ]);

  return (
    <StoreSectionGuard storeId={storeId} id="settings">
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="General"
            description="The store's name, status and defaults."
            action={
              store.ok ? (
                <Badge tone={STATUS_TONE[store.data.status] ?? 'neutral'}>
                  {store.data.status}
                </Badge>
              ) : undefined
            }
          />
          <CardBody>
            {!store.ok ? (
              <ApiStatePanel
                status={store.status}
                error={store.error}
                what="This store"
                storeId={storeId}
              />
            ) : can.canEditStore ? (
              <GeneralSettingsForm storeId={storeId} current={forStoreSettings(store.data)} />
            ) : (
              <div className="space-y-4">
                <ReadOnlyGeneral store={store.data} />
                <Needs relation="store_admin" object={storeObject} to="Changing these" />
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Domains"
            description="Where the storefront answers. A new domain is unverified until DNS points at it."
          />
          <CardBody className="space-y-4">
            {domains.ok ? (
              <DomainList
                domains={domains.data.items}
                storeId={storeId}
                canMovePrimary={can.canMovePrimary}
              />
            ) : (
              <RequestErrorPanel status={domains.status} error={domains.error} />
            )}
            {can.canAddDomain ? (
              <AddDomainForm storeId={storeId} />
            ) : (
              <Needs
                relation="owner"
                object="organization:hq"
                to="Adding a domain or moving the primary"
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Sales channels" description="Web, app, marketplace and POS." />
          <CardBody className="space-y-4">
            {channels.ok ? (
              <SalesChannelList channels={channels.data.items} />
            ) : (
              <RequestErrorPanel status={channels.status} error={channels.error} />
            )}
            {can.canCreateChannel ? (
              <CreateSalesChannelForm storeId={storeId} />
            ) : (
              <Needs relation="store_admin" object={storeObject} to="Creating a channel" />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="API keys"
            description="Publishable keys for the storefront. A new key's value is shown once and cannot be retrieved again."
          />
          <CardBody className="space-y-4">
            {keys === null ? (
              <ForbiddenPanel
                error={requiresRelation('store_admin', storeObject)}
                hint="Keys are listed to store admins only."
              />
            ) : keys.ok ? (
              <>
                <ApiKeyList
                  keys={keys.data.items}
                  channels={channels.ok ? channels.data.items : []}
                  storeId={storeId}
                  canRevoke={can.canManageKeys}
                />
                <CreateApiKey
                  storeId={storeId}
                  channels={channels.ok ? forChannelOptions(channels.data.items) : []}
                  types={['publishable']}
                />
              </>
            ) : (
              <RequestErrorPanel status={keys.status} error={keys.error} />
            )}
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
