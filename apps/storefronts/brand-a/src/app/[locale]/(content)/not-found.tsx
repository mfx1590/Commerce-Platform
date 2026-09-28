import { buttonVariants } from '@platform/ui';
import { getLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { createContentContext } from '@/lib/cms/content';

/** 404 inside the content group, in the request's language (`not-found` receives no params). */
export default async function ContentNotFound() {
  const ctx = createContentContext({ locale: await getLocale() });
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-3xl font-bold">{ctx.t('page.notFound.title')}</h1>
      <p className="text-muted-foreground">{ctx.t('page.notFound.body')}</p>
      <Link href="/" className={buttonVariants({ variant: 'outline' })}>
        {ctx.t('page.notFound.back')}
      </Link>
    </div>
  );
}
