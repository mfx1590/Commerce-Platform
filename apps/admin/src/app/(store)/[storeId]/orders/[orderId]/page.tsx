import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getOrder, getStore, listWarehouses } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { formatMoney } from '@/lib/forms/money';
import { orderPermissions, type OrderPermissions } from '@/lib/orders/permissions';
import { supportRefundLimitMinor } from '@/lib/orders/refunds';
import { loadPrincipal } from '@/lib/principal';
import { statusLabel, toneFor } from '../orders-table.config';
import { LineItemsPanel } from './line-items-panel';
import { OrderActions } from './order-actions';
import { FulfilmentPanel } from './shipments-panel';
import { Timeline } from './timeline';

export const dynamic = 'force-dynamic';

type Address = AdminComponents['Address'];

const NO_PERMISSIONS: OrderPermissions = {
  canEditOrder: false,
  canRefund: false,
  canRequestReturn: false,
  canFulfil: false,
  canReceiveReturn: false,
};

/**
 * The address is rendered here, in the server component, and never handed to a client component:
 * the `support` gate on this screen is the only thing between customer PII and the browser bundle,
 * so the PII stays in server-rendered HTML rather than in client props.
 */
function AddressBlock({ title, address }: { title: string; address: Address }) {
  return (
    <div>
      <h3 className="text-muted mb-1 text-xs tracking-wide uppercase">{title}</h3>
      <address className="text-sm not-italic">
        {address.first_name} {address.last_name}
        {address.company !== null && (
          <>
            <br />
            {address.company}
          </>
        )}
        <br />
        {address.line1}
        {address.line2 !== null && (
          <>
            <br />
            {address.line2}
          </>
        )}
        <br />
        {address.postal_code} {address.city}
        {address.region !== null ? `, ${address.region}` : ''}
        <br />
        {address.country}
        {address.phone !== null && (
          <>
            <br />
            {address.phone}
          </>
        )}
      </address>
    </div>
  );
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ storeId: string; orderId: string }>;
}) {
  const { storeId, orderId } = await params;
  const [order, store, principal] = await Promise.all([
    getOrder(storeId, orderId),
    getStore(storeId),
    loadPrincipal(),
  ]);

  if (!order.ok) {
    return (
      <StoreSectionGuard storeId={storeId} id="orders">
        <ApiStatePanel
          status={order.status}
          error={order.error}
          what="This order"
          storeId={storeId}
          backHref={`/${storeId}/orders`}
          backLabel="All orders"
        />
      </StoreSectionGuard>
    );
  }

  const current = order.data;
  const locale = store.ok ? store.data.default_locale : 'en-GB';
  const refundLimit = store.ok ? supportRefundLimitMinor(store.data.settings) : null;
  const permissions = principal.ok ? orderPermissions(principal.data, storeId) : NO_PERMISSIONS;
  // Warehouses are only needed by the fulfilment forms; the call is HQ-gated, so it is made only
  // for a principal who may fulfil, and fails alone.
  const warehouses =
    permissions.canFulfil || permissions.canReceiveReturn ? await listWarehouses() : null;
  const money = (amountMinor: number, currency: string) =>
    formatMoney(amountMinor, currency, locale);

  return (
    <StoreSectionGuard storeId={storeId} id="orders">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">Order #{current.display_id}</h1>
          <Badge tone={toneFor(current.status)}>{statusLabel(current.status)}</Badge>
          <Badge tone={toneFor(current.payment_status)}>
            {statusLabel(current.payment_status)}
          </Badge>
          <Badge tone={toneFor(current.fulfillment_status)}>
            {statusLabel(current.fulfillment_status)}
          </Badge>
          <Link href={`/${storeId}/orders`} className="text-accent ml-auto text-sm hover:underline">
            All orders
          </Link>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Lines"
              description={
                permissions.canEditOrder
                  ? 'Before fulfilment a line can be lowered or cancelled; the last line cannot — cancel the order instead.'
                  : 'Quantities, prices and what has shipped or come back.'
              }
            />
            <CardBody>
              <LineItemsPanel
                storeId={storeId}
                order={current}
                locale={locale}
                canEdit={permissions.canEditOrder}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Totals" />
            <CardBody>
              <dl className="space-y-1 text-sm">
                {(
                  [
                    ['Subtotal', current.totals.subtotal],
                    ['Discount', current.totals.discount],
                    ['Shipping', current.totals.shipping],
                    ['Tax', current.totals.tax],
                  ] as const
                ).map(([label, amount]) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-muted">{label}</dt>
                    <dd className="font-mono">{money(amount.amount_minor, amount.currency)}</dd>
                  </div>
                ))}
                <div className="border-line flex justify-between border-t pt-1 font-medium">
                  <dt>Total</dt>
                  <dd className="font-mono">
                    {money(current.totals.total.amount_minor, current.totals.total.currency)}
                  </dd>
                </div>
              </dl>
              <p className="text-muted mt-3 text-xs">
                {current.currency} · {current.locale}
                {current.promotion_codes.length > 0 && (
                  <> · codes {current.promotion_codes.join(', ')}</>
                )}
              </p>
              <p className="text-muted mt-1 text-xs">
                Shipping: {current.shipping_method.name} ({current.shipping_method.carrier}) ·{' '}
                {money(
                  current.shipping_method.price.amount_minor,
                  current.shipping_method.price.currency,
                )}
              </p>
            </CardBody>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Customer"
              description="Personal data — shown because your relation allows it; it is never logged."
            />
            <CardBody className="grid gap-4 sm:grid-cols-3">
              <div>
                <h3 className="text-muted mb-1 text-xs tracking-wide uppercase">Email</h3>
                <p className="text-sm">{current.email}</p>
              </div>
              <AddressBlock title="Shipping address" address={current.shipping_address} />
              <AddressBlock title="Billing address" address={current.billing_address} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Actions"
              description="Each one asks first and is re-checked server-side."
            />
            <CardBody>
              <OrderActions
                storeId={storeId}
                order={current}
                locale={locale}
                permissions={permissions}
                supportRefundLimitMinor={refundLimit}
              />
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Fulfilment"
            description="Shipments and returns. Planning, picking, packing and receiving need operations on HQ."
          />
          <CardBody>
            <FulfilmentPanel
              storeId={storeId}
              order={current}
              locale={locale}
              permissions={permissions}
              warehouses={warehouses !== null && warehouses.ok ? warehouses.data.items : []}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Timeline" />
          <CardBody>
            <Timeline order={current} locale={locale} />
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
