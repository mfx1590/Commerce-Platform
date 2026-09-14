import { cn } from '@platform/ui';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { CHECKOUT_STEPS, isStepReachable, stepPath, type CheckoutStep } from '@/lib/checkout';
import type { Cart } from '@/lib/store-api';

/**
 * Progress indicator. A completed step stays a link so the customer can go back and change an
 * address; a step the cart cannot support yet is plain text, matching the server-side guard.
 */
export function CheckoutSteps({ cart, current }: { cart: Cart; current: CheckoutStep }) {
  const t = useTranslations('checkout');

  return (
    <nav aria-label={t('progress')} className="mb-8">
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {CHECKOUT_STEPS.map((step, index) => {
          const active = step === current;
          const reachable = isStepReachable(cart, step);
          const label = `${index + 1}. ${t(`steps.${step}`)}`;

          return (
            <li key={step} className="flex items-center gap-2">
              {index > 0 ? (
                <span aria-hidden="true" className="text-muted-foreground">
                  ›
                </span>
              ) : null}
              {reachable && !active ? (
                <Link href={stepPath(step)} className="text-muted-foreground hover:underline">
                  {label}
                </Link>
              ) : (
                <span
                  aria-current={active ? 'step' : undefined}
                  className={cn(active ? 'font-medium' : 'text-muted-foreground')}
                >
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
