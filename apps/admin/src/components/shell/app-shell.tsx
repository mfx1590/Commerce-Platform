import type { ReactNode } from 'react';
import { MedusaRail } from '@/components/rail/medusa-rail';
import styles from '@/components/rail/medusa-rail.module.css';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StoreSwitcher } from './store-switcher';
import type { NavItem, Principal, PrincipalStore } from '@/lib/nav/navigation';

/**
 * The frame both views share: the Medusa rail on the left, a slim bar and the page on the right.
 * Which nav items arrive here is already decided (see `src/lib/nav/navigation.ts`); the shell
 * only lays them out. The rail gets both scopes' items and shows the switch when both exist.
 */
export function AppShell({
  principal,
  hqItems,
  storeItems,
  stores,
  selectedStoreId,
  children,
}: {
  principal: Principal;
  hqItems: NavItem[];
  storeItems: NavItem[];
  stores: readonly PrincipalStore[];
  selectedStoreId: string | null;
  children: ReactNode;
}) {
  const selected = stores.find((store) => store.store_id === selectedStoreId) ?? null;

  return (
    <div className={styles.shell}>
      <MedusaRail
        hqItems={hqItems}
        storeItems={storeItems}
        storeName={selected?.name ?? null}
        userName={principal.user.display_name}
      />

      <div className="min-w-0">
        <header className="border-line bg-surface border-b">
          <div className="flex flex-wrap items-center gap-4 px-8 py-3">
            {selected !== null && <Badge tone="accent">{selected.code}</Badge>}
            <div className="ml-auto flex items-center gap-3">
              <StoreSwitcher stores={stores} selectedStoreId={selectedStoreId} />
              <form action="/api/auth/logout" method="post">
                <Button type="submit" variant="secondary" size="sm">
                  Sign out
                </Button>
              </form>
            </div>
          </div>
        </header>

        <main className="px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
