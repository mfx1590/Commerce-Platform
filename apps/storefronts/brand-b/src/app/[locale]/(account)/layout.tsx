import type { ReactNode } from 'react';
import { getLayouts } from '@/lib/slots';
import { getStoreOrNull } from '@/lib/store';

/**
 * Account area. Window 13 takes this route group over in Phase 3 (docs/ownership.md), so it keeps
 * the shop chrome and adds nothing the customer module would have to unpick.
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  const store = await getStoreOrNull();
  const { Header, Footer } = getLayouts();

  return (
    <div className="flex min-h-screen flex-col">
      <Header store={store} />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10">{children}</main>
      <Footer store={store} />
    </div>
  );
}
