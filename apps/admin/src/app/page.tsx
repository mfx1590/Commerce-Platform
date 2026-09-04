import { redirect } from 'next/navigation';
import { Shell } from '@/components/shell/shell';
import { NoAccessPanel } from '@/components/states/state-panel';
import { landingPath } from '@/lib/nav/navigation';
import { readRememberedStoreId } from '@/lib/nav/selected-store';
import { loadPrincipal } from '@/lib/principal';

export const dynamic = 'force-dynamic';

/**
 * `/` has no content of its own: it sends each principal to the first section they may actually
 * open — HQ users to their first HQ section, store users to their remembered store. Only an account
 * with no relations at all stops here, and it gets an explanation rather than a blank page.
 */
export default async function HomePage() {
  const result = await loadPrincipal();

  if (result.ok) {
    const target = landingPath(result.data, await readRememberedStoreId());
    if (target !== null) {
      redirect(target);
    }
    return (
      <Shell>
        <NoAccessPanel />
      </Shell>
    );
  }

  // Let the shell render the 401/403/error panel; it already knows how.
  return <Shell>{null}</Shell>;
}
