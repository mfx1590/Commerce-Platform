import { Badge } from '@platform/ui';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { Order } from '@/lib/store-api';
import { orderConfirmationHooks } from '@/lib/test-hooks';

type OrderStatus = Order['status'];

/**
 * The top of the order confirmation page (#351): only what the customer can rely on.
 *
 * The order number, that the order has been placed and is being processed, and where to follow
 * it — Order history for a signed-in customer; for a guest, the order number itself. It says
 * **nothing about an email**: no part of the platform sends one yet (notifications are Phase 4), and
 * the order is `pending` until the core confirms it. When a confirmation email is really sent, a
 * sentence about it comes back — conditionally, on the fact that it was sent.
 *
 * The status line (#372) is the order's own `status` as the core reports it, translated — never
 * worked out here — and the sentence above it follows that status, so a delivered or cancelled
 * order is not described as "being processed".
 *
 * Wording pinned by `test/order-confirmation-header.test.ts`.
 */
export function OrderConfirmationHeader({
  order,
  signedIn,
}: {
  order: { id: string; display_id: number | string; status: OrderStatus };
  signedIn: boolean;
}) {
  const t = useTranslations('checkout.confirmation');
  return (
    <header className="flex flex-col items-start gap-2" {...orderConfirmationHooks(order)}>
      <Badge variant="success">{t('badge')}</Badge>
      <h1 className="text-3xl font-bold">{t('title')}</h1>
      <p className="text-muted-foreground">
        {t(`bodyByStatus.${order.status}`, { order: order.display_id })}
      </p>
      <p className="text-sm" data-testid="order-status">
        {t('statusLabel')} <span className="font-medium">{t(`status.${order.status}`)}</span>
      </p>
      {signedIn ? (
        <p className="text-muted-foreground">
          {t('followSignedIn')}{' '}
          <Link
            href="/account/orders"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t('orderHistory')}
          </Link>
        </p>
      ) : (
        <p className="text-muted-foreground">{t('followGuest', { order: order.display_id })}</p>
      )}
    </header>
  );
}
