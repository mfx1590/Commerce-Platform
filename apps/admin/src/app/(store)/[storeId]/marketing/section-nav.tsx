import Link from 'next/link';
import { MARKETING_TABS, marketingHref } from './_sections';

/**
 * Sub-navigation inside the Marketing section. A server component: it has no state, and `aria-current` is
 * decided from the active segment the page already knows.
 */
export function MarketingNav({ storeId, active }: { storeId: string; active: string }) {
  return (
    <nav aria-label="Marketing sections" className="border-line flex gap-1 border-b">
      {MARKETING_TABS.map((tab) => {
        const current = tab.segment === active;
        return (
          <Link
            key={tab.segment === '' ? 'overview' : tab.segment}
            href={marketingHref(storeId, tab.segment)}
            aria-current={current ? 'page' : undefined}
            title={tab.description}
            className={
              current
                ? 'border-accent text-ink -mb-px border-b-2 px-3 py-2 text-sm font-medium'
                : 'text-muted hover:text-ink -mb-px border-b-2 border-transparent px-3 py-2 text-sm'
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
