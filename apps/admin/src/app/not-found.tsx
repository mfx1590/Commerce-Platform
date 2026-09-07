import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { StatePanel } from '@/components/states/state-panel';

/** A URL that matches no route at all. Route-level 404s use `NotFoundPanel`, which can say which
 * store was searched; this one cannot know that, so it only offers the way back. */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <StatePanel
        title="Page not found"
        description="That address does not match anything in the admin app."
        action={
          <Link href="/">
            <Button variant="secondary">Go to your first section</Button>
          </Link>
        }
      />
    </main>
  );
}
