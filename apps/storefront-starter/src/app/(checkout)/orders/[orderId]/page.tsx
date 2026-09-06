import { Badge, Price, buttonVariants } from '@platform/ui';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AddressCard, TotalsTable } from '@/components/order-summary';
import { getStoreOrNull } from '@/lib/store';
import { isNotFound, storeApi } from '@/lib/store-api';

export const metadata: Metadata = { title: 'Order confirmation' };
export const dynamic = 'force-dynamic';

type Params = Promise<{ orderId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Order confirmation. `GET /store/orders/{id}` needs the email the order was placed with — it is
 * what authorises a guest to see it. `placeOrderAction` puts that email in a short-lived httpOnly
 * cookie, so the address never appears in a URL that could be shared or logged; a returning
 * customer can still pass `?email=` from the link in their confirmation mail.
 */
export default async function OrderConfirmationPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { orderId } = await params;
  const { email: emailParam } = await searchParams;
  const cookieEmail = (await cookies()).get('order_email')?.value;
  const email = typeof emailParam === 'string' ? emailParam : cookieEmail;

  if (email === undefined) {
    return (
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-2xl font-bold">Order not available</h1>
        <p className="text-muted-foreground">
          Open the link from your confirmation email to see this order, or sign in to your account.
        </p>
        <Link href="/account" className={buttonVariants({ variant: 'outline' })}>
          Go to your account
        </Link>
      </div>
    );
  }

  const [store, order] = await Promise.all([
    getStoreOrNull(),
    storeApi()
      .getOrder(orderId, { email }, { cache: 'no-store' })
      .catch((error: unknown) => {
        if (isNotFound(error)) notFound();
        throw error;
      }),
  ]);
  const locale = store?.default_locale ?? 'en-US';

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-2">
        <Badge variant="success">Order placed</Badge>
        <h1 className="text-3xl font-bold">Thank you</h1>
        <p className="text-muted-foreground">
          Order <span className="font-medium">#{order.display_id}</span> is confirmed. We have sent
          a confirmation to {order.email}.
        </p>
      </header>

      <ul className="flex flex-col divide-y divide-border">
        {order.items.map((item) => (
          <li key={item.id} className="flex justify-between gap-4 py-3">
            <span>
              <span className="font-medium">{item.title}</span>{' '}
              <span className="text-muted-foreground">
                {item.variant_title} × {item.quantity}
              </span>
            </span>
            <Price value={item.total} locale={locale} />
          </li>
        ))}
      </ul>

      <div className="grid gap-6 sm:grid-cols-2">
        <AddressCard title="Delivery address" address={order.shipping_address} />
        <div className="flex flex-col gap-1 text-sm">
          <h3 className="font-medium">Delivery</h3>
          <p className="text-muted-foreground">
            {order.shipping_method.name} · {order.shipping_method.carrier}
          </p>
        </div>
      </div>

      <div className="sm:ml-auto sm:w-80">
        <TotalsTable totals={order.totals} locale={locale} />
      </div>

      <Link href="/products" className={buttonVariants({ variant: 'outline' })}>
        Continue shopping
      </Link>
    </div>
  );
}
