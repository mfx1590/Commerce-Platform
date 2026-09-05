import { buttonVariants } from '@platform/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CartLine, EmptyCart } from '@/components/cart-line';
import { TotalsTable } from '@/components/order-summary';
import { getCart } from '@/lib/cart';
import { getStoreOrNull } from '@/lib/store';

export const metadata: Metadata = { title: 'Cart' };

/** The cart is per-customer state read from a cookie: never cached, never prerendered. */
export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const [cart, store] = await Promise.all([getCart(), getStoreOrNull()]);
  const locale = store?.default_locale ?? 'en-US';

  if (cart === null || cart.items.length === 0) {
    return (
      <>
        <h1 className="text-3xl font-bold">Cart</h1>
        <EmptyCart />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl font-bold">Cart</h1>

      <ul className="flex flex-col">
        {cart.items.map((item) => (
          <CartLine key={item.id} item={item} locale={locale} />
        ))}
      </ul>

      <div className="flex flex-col gap-6 sm:ml-auto sm:w-80">
        <TotalsTable totals={cart.totals} locale={locale} />
        <Link href="/checkout" className={buttonVariants({ size: 'lg' })}>
          Checkout
        </Link>
        <Link href="/products" className="text-center text-sm underline">
          Continue shopping
        </Link>
      </div>
    </div>
  );
}
