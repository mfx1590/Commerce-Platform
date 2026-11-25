import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel, RequestErrorPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import {
  getCustomer,
  getCustomerIdentity,
  listCustomerAddresses,
  listCustomerConsents,
  listCustomerGroups,
  listStores,
} from '@/lib/api/admin';
import {
  addressLines,
  addressPhone,
  defaultLabels,
  sortAddresses,
  type CustomerAddress,
} from '@/lib/customers/addresses';
import { channelLabel, consentRows } from '@/lib/customers/consent';
import { findStore, type Principal } from '@/lib/nav/navigation';
import type { Relation } from '@/lib/nav/relations';
import { expandOrganizationRelations, expandStoreRelations } from '@/lib/nav/relations';
import { loadPrincipal } from '@/lib/principal';
import { customerTone, displayName } from '../customers-table.config';
import { CustomerForm } from './customer-form';
import { EraseControl } from './erase-control';
import { ActivityPanel, activityPage } from '@/components/audit/activity-panel';
import { loadActivity } from '@/lib/audit/load';

export const dynamic = 'force-dynamic';

function canErase(principal: Principal, storeId: string): boolean {
  const store = findStore(principal, storeId);
  return expandStoreRelations(
    (store?.relations ?? []) as Relation[],
    principal.organization_relations as Relation[],
  ).has('store_admin');
}

function formatAt(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * One customer. The PII (email, name, phone, addresses, consent) is rendered here, in the server
 * component, behind the `support` gate; the client components below receive exactly the fields they
 * show — the edit form its four inputs and the group options, the erase control only ids. Nothing
 * is logged.
 *
 * **Addresses never cross to the browser** (#870 item 4). `Address` is one of the records
 * `src/lib/client-safe.ts` polices, and this panel has no interactivity, so it is rendered here and
 * no projection of an address exists.
 *
 * **The consent ledger is not the same thing as `Customer.consent`.** The embedded object is the
 * current state; `listCustomerConsents` is every recorded decision with its source and policy
 * version. Both are shown, because "is she opted in?" and "when did she say so, and where?" are
 * different questions.
 *
 * **Cross-brand identity is HQ-only, and asked for only by someone who may have it.**
 * `getCustomerIdentity` needs `support` on `organization:hq` — a store admin with every relation on
 * their own stores is refused by design. So the call is made only for a principal holding that
 * organization relation; everyone else is told the panel is HQ-only rather than shown a 403. The
 * answer is **ids only**: no email, no subject, no hash. Naming the sibling customers would need
 * one `getCustomer` per store, each behind its own `support`, so the panel names the STORES and
 * says what it cannot resolve.
 */
export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string; customerId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId, customerId } = await params;
  const page = activityPage((await searchParams)?.['activity']);
  const [customer, principal, activity, addresses, consents, groups] = await Promise.all([
    getCustomer(storeId, customerId),
    loadPrincipal(),
    loadActivity({ storeId, entityType: 'customer', entityId: customerId, page }),
    listCustomerAddresses(storeId, customerId),
    listCustomerConsents(storeId, customerId),
    listCustomerGroups(storeId),
  ]);

  if (!customer.ok) {
    return (
      <StoreSectionGuard storeId={storeId} id="customers">
        <ApiStatePanel
          status={customer.status}
          error={customer.error}
          what="This customer"
          storeId={storeId}
          backHref={`/${storeId}/customers`}
          backLabel="All customers"
        />
      </StoreSectionGuard>
    );
  }

  const current = customer.data;
  // `support` on organization:hq, not on this store: the contract refuses a store-scoped caller,
  // so the question is asked only by someone who can be answered.
  const hqSupport =
    principal.ok &&
    expandOrganizationRelations(principal.data.organization_relations as Relation[]).has('support');
  const identity =
    hqSupport && current.identity_id !== null
      ? await getCustomerIdentity(current.identity_id)
      : null;
  // Store names for the identity panel; `listStores` is viewer on store:*, which an HQ support
  // principal holds. Only ever called for them, and it carries no customer data.
  const stores = identity !== null && identity.ok ? await listStores({ limit: 100 }) : null;
  const storeName = new Map<string, string>(
    stores !== null && stores.ok
      ? stores.data.items.map((store) => [store.id, `${store.name} (${store.code})`])
      : [],
  );
  const groupOptions = groups.ok
    ? groups.data.items.map((group) => ({ value: group.id, label: group.name }))
    : [];
  const erased = current.status === 'erased';
  const consent = consentRows(current.consent);
  const mayErase = principal.ok && canErase(principal.data, storeId) && !erased;

  return (
    <StoreSectionGuard storeId={storeId} id="customers">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{displayName(current)}</h1>
          <Badge tone={customerTone(current.status)}>{current.status}</Badge>
          <Link
            href={`/${storeId}/customers`}
            className="text-accent ml-auto text-sm hover:underline"
          >
            All customers
          </Link>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Profile"
              description="Personal data — shown because your relation allows it; it is never logged."
            />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0">
                <h3 className="text-muted mb-1 text-xs tracking-wide uppercase">Email</h3>
                <p className="text-sm break-all">{current.email}</p>
              </div>
              <div>
                <h3 className="text-muted mb-1 text-xs tracking-wide uppercase">Phone</h3>
                <p className="text-sm">{current.phone ?? '—'}</p>
              </div>
              <div>
                <h3 className="text-muted mb-1 text-xs tracking-wide uppercase">Identity</h3>
                <p className="font-mono text-xs">{current.identity_id ?? 'guest (no account)'}</p>
              </div>
              <div>
                <h3 className="text-muted mb-1 text-xs tracking-wide uppercase">Since</h3>
                <p className="text-sm">{formatAt(current.created_at)}</p>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Orders" />
            <CardBody className="space-y-3">
              <p className="text-muted text-sm">
                The orders list filters by customer id, so this customer&apos;s history is one click
                away.
              </p>
              {/*
                #870 item 4: this linked `?q=<email>` until now, which put a customer's email
                address into a URL — and so into browser history, into the referrer of anything the
                orders page loads, and into any log that records paths. `listOrders` has taken an
                exact `customer_id` since Admin API 0.4.24 (#569), which is both private and more
                accurate: `q` also matches a display id, and two customers can share an email
                across stores.
              */}
              <Link href={`/${storeId}/orders?customer_id=${current.id}`}>
                <Button size="sm" variant="secondary">
                  Orders by this customer
                </Button>
              </Link>
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Addresses"
            description="Everything the customer has saved, defaults first. Rendered on the server: an address never reaches the browser as data."
          />
          <CardBody>
            {!addresses.ok ? (
              <RequestErrorPanel status={addresses.status} error={addresses.error} />
            ) : addresses.data.items.length === 0 ? (
              <p className="text-muted text-sm">
                No address saved. A guest checkout records the address on the order, not on the
                customer.
              </p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2" aria-label="Saved addresses">
                {sortAddresses(addresses.data.items as CustomerAddress[]).map((address) => {
                  const phone = addressPhone(address);
                  return (
                    <li key={address.id} className="border-line rounded-md border px-3 py-2">
                      <div className="mb-1 flex flex-wrap gap-1">
                        {defaultLabels(address).map((label) => (
                          <Badge key={label} tone="accent">
                            {label}
                          </Badge>
                        ))}
                      </div>
                      {addressLines(address).length === 0 ? (
                        // Every field blank or whitespace: say so rather than render an empty box
                        // the reader has to interpret.
                        <p className="text-muted text-sm">Nothing recorded on this address.</p>
                      ) : (
                        addressLines(address).map((line, index) => (
                          <p key={`${address.id}-${index}`} className="text-sm">
                            {line}
                          </p>
                        ))
                      )}
                      {phone !== null && (
                        <p className="text-muted mt-1 text-xs">Contact on this address: {phone}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Consent"
            description="Per channel, with when and where it was given. Consent is recorded by the storefront and the core; it is not edited here."
          />
          <CardBody>
            {consent.length === 0 ? (
              <p className="text-muted text-sm">No consent recorded.</p>
            ) : (
              <table className="w-full text-sm" aria-label="Consent by channel">
                <thead className="border-line border-b">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Channel
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Granted
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      When
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Source
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {consent.map((row) => (
                    <tr key={row.channel}>
                      <td className="px-3 py-2">{channelLabel(row.channel)}</td>
                      <td className="px-3 py-2">
                        {row.granted === null ? (
                          <span className="text-muted">not stated</span>
                        ) : (
                          <Badge tone={row.granted ? 'success' : 'neutral'}>
                            {row.granted ? 'granted' : 'withheld'}
                          </Badge>
                        )}
                      </td>
                      <td className="text-muted px-3 py-2 font-mono text-xs">{formatAt(row.at)}</td>
                      <td className="px-3 py-2">
                        {row.raw !== null ? (
                          <code className="text-muted text-xs">{row.raw}</code>
                        ) : (
                          (row.source ?? '—')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Consent history"
            description="Every decision the core recorded, newest first — when it was made, where it came from, and the policy version it was given under. The table above is only the current state."
          />
          <CardBody>
            {!consents.ok ? (
              <RequestErrorPanel status={consents.status} error={consents.error} />
            ) : consents.data.items.length === 0 ? (
              <p className="text-muted text-sm">
                No decision recorded yet. A customer who has never been asked has no row here, which
                is not the same as a refusal.
              </p>
            ) : (
              <table className="w-full text-sm" aria-label="Consent history">
                <thead className="border-line text-muted border-b text-left text-xs">
                  <tr>
                    <th className="px-3 py-2">Recorded</th>
                    <th className="px-3 py-2">Purpose</th>
                    <th className="px-3 py-2">Decision</th>
                    <th className="px-3 py-2">Where from</th>
                    <th className="px-3 py-2">Policy</th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {consents.data.items.map((entry) => (
                    <tr key={entry.id}>
                      <td className="text-muted px-3 py-2 font-mono text-xs">
                        {formatAt(entry.recorded_at)}
                      </td>
                      <td className="px-3 py-2">{channelLabel(entry.purpose)}</td>
                      <td className="px-3 py-2">
                        <Badge tone={entry.granted ? 'success' : 'neutral'}>
                          {entry.granted ? 'granted' : 'withdrawn'}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{entry.source}</td>
                      <td className="text-muted px-3 py-2 font-mono text-xs">
                        {entry.policy_version}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Across the organization"
            description="Whether this person shops under more than one brand. Ids only — no email, no account subject — and HQ-only by contract."
          />
          <CardBody className="space-y-2">
            {current.identity_id === null ? (
              <p className="text-muted text-sm">
                A guest with no account, so there is nothing to link across brands.
              </p>
            ) : !hqSupport ? (
              <p className="text-muted text-sm">
                HQ only: linking one person&rsquo;s records across brands needs{' '}
                <span className="font-mono text-xs">support</span> on{' '}
                <span className="font-mono text-xs">organization:hq</span>, which no relation on a
                single store grants. Ask an organization owner.
              </p>
            ) : identity === null || !identity.ok ? (
              <RequestErrorPanel
                status={identity?.status ?? 0}
                error={identity?.error ?? { code: 'unavailable', message: 'No answer' }}
              />
            ) : (
              <>
                <ul className="divide-line divide-y text-sm" aria-label="Records across brands">
                  {identity.data.customers.map((row) => (
                    <li
                      key={`${row.store_id}-${row.customer_id}`}
                      className="flex flex-wrap items-center gap-2 py-2"
                    >
                      <span>{storeName.get(row.store_id) ?? row.store_id}</span>
                      {row.customer_id === current.id ? (
                        <Badge tone="accent">this record</Badge>
                      ) : (
                        <Link
                          href={`/${row.store_id}/customers/${row.customer_id}`}
                          className="text-accent text-sm hover:underline"
                        >
                          Open
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-muted text-xs">
                  The names and emails of the other records are not shown: reading one costs a
                  separate request per store, each needing{' '}
                  <span className="font-mono">support</span> on that store. Open a record to see it
                  under its own gate.
                </p>
              </>
            )}
          </CardBody>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Edit"
              description={
                erased
                  ? 'An erased customer cannot be edited.'
                  : 'Name, phone, group and status. Editing needs support on this store.'
              }
            />
            <CardBody>
              {erased ? (
                <p className="text-muted text-sm">
                  This record was anonymised on request; the order financials are kept.
                </p>
              ) : (
                <CustomerForm
                  groupOptions={groupOptions}
                  storeId={storeId}
                  customerId={current.id}
                  defaultValues={{
                    first_name: current.first_name ?? '',
                    last_name: current.last_name ?? '',
                    phone: current.phone ?? '',
                    customer_group_id: current.customer_group_id ?? '',
                    status: current.status === 'disabled' ? 'disabled' : 'registered',
                  }}
                  statusEditable={current.status === 'registered' || current.status === 'disabled'}
                />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Erase (GDPR)"
              description="Anonymises the personal data and keeps the order financials. Needs store_admin; it cannot be undone."
            />
            <CardBody>
              {erased ? (
                <p className="text-muted text-sm">Already erased.</p>
              ) : mayErase ? (
                <EraseControl storeId={storeId} customerId={current.id} />
              ) : (
                <p className="text-muted text-sm">
                  Only a store admin can erase a customer. Ask one, or an organization owner.
                </p>
              )}
            </CardBody>
          </Card>
        </div>

        <ActivityPanel
          activity={activity}
          entityType="customer"
          basePath={`/${storeId}/customers/${customerId}`}
          note="The core records which fields changed, never their values, for a customer."
        />
      </div>
    </StoreSectionGuard>
  );
}
