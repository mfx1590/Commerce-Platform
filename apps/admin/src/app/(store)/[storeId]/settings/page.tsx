import { CreateApiKey } from '@/components/registry/api-key-create';
import { AddDomainForm } from '@/components/registry/domain-form';
import { ApiKeyList, DomainList, SalesChannelList } from '@/components/registry/lists';
import { CreateSalesChannelForm } from '@/components/registry/sales-channel-form';
import Link from 'next/link';
import { ActivityPanel, activityPage } from '@/components/audit/activity-panel';
import { loadActivity } from '@/lib/audit/load';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { SETTINGS_CARDS, describeValue, valueAt } from '@/lib/settings/fields';
import { formatMoney } from '@/lib/forms/money';
import { SettingsCardForm, cardValues } from './settings-card-form';
import {
  ApiStatePanel,
  ForbiddenPanel,
  RequestErrorPanel,
  requiresRelation,
} from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import {
  getStore,
  listApiKeys,
  listCategories,
  listDomains,
  listSalesChannels,
  listTaxRates,
  listShippingOptions,
} from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { loadPrincipal } from '@/lib/principal';
import {
  forChannelOptions,
  forStoreSettings,
  paymentSettingsFrom,
  settingsPermissions,
  type SettingsPermissions,
} from '@/lib/settings';
import { mayManageTaxRates } from '@/lib/tax-rates';
import { mayManageShippingOptions } from '@/lib/shipping-options';
import {
  CreateShippingOptionForm,
  ShippingOptionsTable,
} from '@/components/shipping-options/shipping-option-forms';
import { CreateTaxRateForm, TaxRatesTable } from '@/components/tax-rates/tax-rate-forms';
import { GeneralSettingsForm } from './general-form';
import { PaymentSettingsForm } from './payment-form';

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
 * Store settings (#117): General, Tax rates (#520), Domains, Sales channels, API keys.
 *
 * store_staff reads everything except the API keys (listing them is store_admin); each form and
 * button is offered only to the relation its operation needs, and otherwise names that relation.
 * The server actions refuse the same way before calling the API (`src/lib/permissions/guard.ts`).
 * General includes the enabled currency/locale sets; Domains moves the primary (owner on hq); API
 * keys revoke after a confirmation, never the last live publishable key (Admin API 0.4.8, #279).
 *
 * Lists render here on the server; the client forms take ids, options and six scalars.
 */
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId } = await params;
  const activityPageNumber = activityPage((await searchParams)?.['activity']);
  const principal = await loadPrincipal();
  const can = principal.ok ? settingsPermissions(principal.data, storeId) : NONE;
  const storeObject = `store:${storeId}`;

  const canManageTax = principal.ok && mayManageTaxRates(principal.data, storeId);
  const canManageShipping = principal.ok && mayManageShippingOptions(principal.data, storeId);
  const [store, domains, channels, keys, taxRates, categories, shippingOptions] = await Promise.all(
    [
      getStore(storeId),
      listDomains(storeId),
      listSalesChannels(storeId),
      // Below store_admin the list is a certain 403; do not ask.
      can.canManageKeys ? listApiKeys(storeId) : Promise.resolve(null),
      listTaxRates(storeId),
      listCategories(storeId),
      listShippingOptions(storeId),
    ],
  );
  // The store's own audit rows (#896 panel, `entity_type: 'store'`): `store.update` carries the
  // changed field names, so a settings change is answerable with "who turned this on".
  const activity = await loadActivity({
    storeId,
    entityType: 'store',
    entityId: storeId,
    page: activityPageNumber,
  });
  const categoryOptions = categories.ok
    ? categories.data.items.map((c) => ({ id: c.id, name: c.name }))
    : [];

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

        <Card id="payment">
          <CardHeader
            title="Payment"
            description="How customers can pay. Card payments need the store's Stripe key, which an operator sets outside the admin; without card or invoice, no order can be placed."
          />
          <CardBody>
            {!store.ok ? (
              <RequestErrorPanel status={store.status} error={store.error} />
            ) : can.canEditStore ? (
              <PaymentSettingsForm
                storeId={storeId}
                invoiceAllowed={paymentSettingsFrom(store.data.settings).invoice_allowed}
                updatedAt={store.data.updated_at}
              />
            ) : (
              <div className="space-y-3">
                <p className="text-sm">
                  Pay on invoice:{' '}
                  <span className="font-medium">
                    {paymentSettingsFrom(store.data.settings).invoice_allowed ? 'on' : 'off'}
                  </span>
                </p>
                <Needs relation="store_admin" object={storeObject} to="Changing payment settings" />
              </div>
            )}
          </CardBody>
        </Card>

        {/*
          #870 item 7: the `store.settings` groups `updateStore` has always accepted and no screen
          showed. Each card saves only its own paths (through a read-modify-write, because
          `updateStore` replaces the whole settings column), and a change to a consequential path
          is confirmed against a diff first. Below `store_admin` the values are still shown — a
          support user reading a store should be able to see how it is configured — with the
          relation they would need to change them.
        */}
        {SETTINGS_CARDS.map((card) => (
          <Card key={card.id} id={`settings-${card.id}`}>
            <CardHeader
              title={card.title}
              description={card.description}
              {...(store.ok
                ? {
                    action: (
                      <Link
                        href={`/${storeId}/settings?activity=1#activity`}
                        className="text-accent text-sm hover:underline"
                      >
                        History
                      </Link>
                    ),
                  }
                : {})}
            />
            <CardBody>
              {/*
                A card may carry something true that its fields cannot show — the refund limit's
                currency is compared without conversion (#969). It is shown to every reader, not
                only to the one who may edit, because it changes what the number means.
              */}
              {card.note === undefined ? null : (
                <p className="text-muted mb-4 text-sm">{card.note}</p>
              )}
              {!store.ok ? (
                <RequestErrorPanel status={store.status} error={store.error} />
              ) : can.canEditStore ? (
                <SettingsCardForm
                  storeId={storeId}
                  cardId={card.id}
                  current={cardValues(card.id, store.data.settings)}
                  updatedAt={store.data.updated_at}
                  currency={store.data.default_currency}
                  locale={store.data.default_locale}
                />
              ) : (
                <div className="space-y-3">
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {card.fields.map((field) => (
                      <div key={field.path}>
                        <dt className="text-muted text-xs tracking-wide uppercase">
                          {field.label}
                        </dt>
                        <dd className="text-sm">
                          {describeValue(
                            field,
                            valueAt(store.data.settings, field.path),
                            (amountMinor) =>
                              formatMoney(
                                amountMinor,
                                store.data.default_currency,
                                store.data.default_locale,
                              ),
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <Needs
                    relation="store_admin"
                    object={storeObject}
                    to={`Changing ${card.title.toLowerCase()}`}
                  />
                </div>
              )}
            </CardBody>
          </Card>
        ))}

        <Card>
          <CardHeader
            title="Tax rates"
            description="One rate per country, optionally per region or category; the most specific wins. Every country the store sells to needs one before it can be active."
          />
          <CardBody className="space-y-4">
            {taxRates.ok ? (
              <TaxRatesTable
                storeId={storeId}
                rates={taxRates.data.items}
                canManage={canManageTax}
                categories={categoryOptions}
              />
            ) : (
              <RequestErrorPanel status={taxRates.status} error={taxRates.error} />
            )}
            {canManageTax ? (
              <CreateTaxRateForm
                storeId={storeId}
                defaultCountry={store.ok ? store.data.default_country : ''}
                categories={categoryOptions}
              />
            ) : (
              <Needs relation="store_admin" object={storeObject} to="Changing tax rates" />
            )}
          </CardBody>
        </Card>

        <Card id="shipping-options">
          <CardHeader
            title="Shipping options"
            description="Where carts can check out to, and at what price. Every country the store sells to needs an active option in the store's default currency before it can be active; options are deactivated, never deleted."
          />
          <CardBody className="space-y-4">
            {shippingOptions.ok ? (
              <ShippingOptionsTable
                storeId={storeId}
                options={shippingOptions.data.items}
                canManage={canManageShipping}
                locale={store.ok ? store.data.default_locale : 'en-GB'}
              />
            ) : (
              <RequestErrorPanel status={shippingOptions.status} error={shippingOptions.error} />
            )}
            {!canManageShipping ? (
              <Needs relation="store_admin" object={storeObject} to="Changing shipping options" />
            ) : store.ok ? (
              <CreateShippingOptionForm
                storeId={storeId}
                currencies={store.data.currencies}
                defaultCurrency={store.data.default_currency}
                defaultCountry={store.data.default_country}
              />
            ) : (
              // No currency fallback (#810): without the store there is no price input.
              <RequestErrorPanel status={store.status} error={store.error} />
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

        {/*
          Where the cards' "History" links point: the store's own audit rows. `store.update` records
          the changed field names, so "who turned prices-include-tax on" is answerable here, by
          anyone who can read this page — the panel's own redaction decides what values show.
        */}
        <div id="activity">
          <ActivityPanel
            activity={activity}
            entityType="store"
            basePath={`/${storeId}/settings`}
            note="A settings change records which fields moved; values appear only for fields that are safe to print."
          />
        </div>
      </div>
    </StoreSectionGuard>
  );
}
