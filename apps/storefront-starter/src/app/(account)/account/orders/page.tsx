import { Badge, Price, buttonVariants } from '@platform/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { requireCustomerToken } from '@/lib/auth/require-customer';
import { getStoreOrNull } from '@/lib/store';
import { storeApi } from '@/lib/store-api';

export const metadata: Metadata = { title: 'Order history' };
export const dynamic = 'force-dynamic';

const STATUS_VARIANT = {
  completed: 'success',
  confirmed: 'neutral',
  processing: 'neutral',
  pending: 'neutral',
  cancelled: 'destructive',
} as const;

export default async function OrderHistoryPage() {
  const token = await requireCustomerToken('/account/orders');
  const [store, orders] = await Promise.all([
    getStoreOrNull(),
    storeApi().listMyOrders({ limit: 20 }, { token, cache: 'no-store' }),
  ]);
  const locale = store?.default_locale ?? 'en-US';

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">Order history</h1>
        <Link href="/account" className={buttonVariants({ variant: 'ghost' })}>
          Back to your account
        </Link>
      </header>

      {orders.items.length === 0 ? (
        <div className="flex flex-col items-start gap-4 py-16">
          <h2 className="text-xl font-semibold">No orders yet</h2>
          <p className="text-muted-foreground">
            When you place an order it will appear here with its delivery status.
          </p>
          <Link href="/products" className={buttonVariants()}>
            Start shopping
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {orders.items.map((order) => (
            <li key={order.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="flex flex-col gap-1">
                <Link href={`/orders/${order.id}`} className="font-medium hover:underline">
                  Order #{order.display_id}
                </Link>
                <time dateTime={order.placed_at} className="text-sm text-muted-foreground">
                  {new Date(order.placed_at).toLocaleDateString(locale, {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </time>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={STATUS_VARIANT[order.status] ?? 'neutral'}>{order.status}</Badge>
                <Price value={order.total} locale={locale} className="font-medium" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
