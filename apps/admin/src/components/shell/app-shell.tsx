import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SideNav } from './side-nav';
import { StoreSwitcher } from './store-switcher';
import type { NavItem, Principal, PrincipalStore } from '@/lib/nav/navigation';

/**
 * The frame both views share. Which nav items arrive here is already decided (see
 * `src/lib/nav/navigation.ts`); the shell only lays them out.
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
    <div className="min-h-screen">
      <header className="border-line bg-surface border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-3">
          <Link href="/" className="text-sm font-semibold">
            Admin
          </Link>
          {selected !== null && <Badge tone="accent">{selected.code}</Badge>}
          <div className="ml-auto flex items-center gap-3">
            <StoreSwitcher stores={stores} selectedStoreId={selectedStoreId} />
            <span className="text-muted hidden text-sm sm:inline">
              {principal.user.display_name}
            </span>
            <form action="/api/auth/logout" method="post">
              <Button type="submit" variant="secondary" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-8 px-6 py-8">
        <aside className="w-48 shrink-0 space-y-6">
          <SideNav label="HQ" items={hqItems} />
          <SideNav label={selected?.name ?? 'Store'} items={storeItems} />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
