import { Button, buttonVariants } from '@platform/ui';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = { title: 'Account deleted' };

/** The goodbye page after `deleteMe` (#470). No token needed: the local session is already gone. */
export const dynamic = 'force-dynamic';

export default function AccountDeletedPage() {
  return (
    <div className="flex max-w-lg flex-col gap-6">
      <h1 className="text-3xl font-bold">Your account has been deleted</h1>
      <p className="text-muted-foreground">
        Your profile, saved addresses and consent choices in this shop are erased. Your orders stay
        on record as the law requires. Finish by signing out of your login session as well.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <form action="/auth/sign-out" method="post">
          <Button type="submit">Finish signing out</Button>
        </form>
        <Link href="/" className={buttonVariants({ variant: 'outline' })}>
          Back to the shop
        </Link>
      </div>
    </div>
  );
}
