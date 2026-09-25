import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getCustomer } from '@/lib/api/admin';
import { channelLabel, consentRows } from '@/lib/customers/consent';
import { findStore, type Principal } from '@/lib/nav/navigation';
import type { Relation } from '@/lib/nav/relations';
import { expandStoreRelations } from '@/lib/nav/relations';
import { loadPrincipal } from '@/lib/principal';
import { customerTone, displayName } from '../customers-table.config';
import { CustomerForm } from './customer-form';
import { EraseControl } from './erase-control';

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
 * One customer. The PII (email, name, phone, consent) is rendered here, in the server component,
 * behind the `support` gate; the client components below receive exactly the fields they show —
 * the edit form its four inputs, the erase control only ids. Nothing is logged.
 */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ storeId: string; customerId: string }>;
}) {
  const { storeId, customerId } = await params;
  const [customer, principal] = await Promise.all([
    getCustomer(storeId, customerId),
    loadPrincipal(),
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
                The orders list filters by email, so this customer&apos;s history is one click away.
              </p>
              <Link href={`/${storeId}/orders?q=${encodeURIComponent(current.email)}`}>
                <Button size="sm" variant="secondary">
                  Orders by this customer
                </Button>
              </Link>
            </CardBody>
          </Card>
        </div>

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
      </div>
    </StoreSectionGuard>
  );
}
