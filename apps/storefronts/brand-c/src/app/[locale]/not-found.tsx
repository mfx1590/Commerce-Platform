import { buttonVariants } from '@platform/ui';
import { Link } from '@/i18n/navigation';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center gap-4 px-4">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="text-muted-foreground">
        That page does not exist in this store, or it is no longer published.
      </p>
      <Link href="/" className={buttonVariants({ variant: 'outline' })}>
        Back to the home page
      </Link>
    </div>
  );
}
