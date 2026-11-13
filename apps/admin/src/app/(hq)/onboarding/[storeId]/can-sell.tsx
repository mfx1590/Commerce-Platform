import Link from 'next/link';
import {
  PAYMENT_METHOD_LABELS,
  WARNING_LABELS,
  canSell,
  productCount,
  type StoreReadiness,
} from '@/lib/readiness';

/**
 * "Can this store sell?" (#830): ACTIVE alone does not mean a customer can buy. From the readiness
 * read: the payment methods the checkout offers, how many products can be bought (published, priced
 * in the store currency, in stock — counted by the core), and each warning with where to fix it.
 * Warnings do not block activation; they say why an active store still takes no orders.
 */
export function CanSellBox({ storeId, readiness }: { storeId: string; readiness: StoreReadiness }) {
  const sells = canSell(readiness);
  return (
    <section
      aria-label="Can this store sell"
      className="border-line space-y-2 rounded-md border px-3 py-2 text-sm"
    >
      <h3 className="font-semibold">Can this store sell?</h3>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[12rem_1fr]">
        <dt className="text-muted">Payment</dt>
        <dd>
          {readiness.payment_methods.length > 0 ? (
            readiness.payment_methods.map((m) => PAYMENT_METHOD_LABELS[m]).join(', ')
          ) : (
            <>
              None —{' '}
              <Link href={`/${storeId}/settings#payment`} className="text-accent hover:underline">
                turn one on in Settings › Payment
              </Link>
            </>
          )}
        </dd>
        <dt className="text-muted">Products customers can buy</dt>
        <dd>{productCount(readiness.purchasable_products)}</dd>
      </dl>
      {readiness.warnings.length > 0 && (
        <ul role="alert" aria-label="Warnings" className="text-warning list-disc space-y-1 pl-5">
          {readiness.warnings.map((warning) => (
            <li key={warning}>
              {WARNING_LABELS[warning] ?? warning}{' '}
              {warning === 'no_purchasable_product' && (
                <Link href={`/${storeId}/catalog`} className="text-accent hover:underline">
                  Open the catalogue
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <p role="status" className={sells ? 'text-success' : 'text-muted'}>
        {sells
          ? 'Yes — customers can place an order.'
          : readiness.status === 'active'
            ? 'Not yet — the store is active, but a customer cannot complete an order.'
            : 'Not yet — the store is not active.'}
      </p>
    </section>
  );
}
