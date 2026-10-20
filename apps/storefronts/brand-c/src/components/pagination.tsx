import { buttonVariants } from '@platform/ui';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { listHref, type ListParams } from '@/lib/catalog';

/** How many numbered pages to show around the current one before eliding. */
const WINDOW = 2;

function pageNumbers(current: number, total: number): (number | 'gap')[] {
  const pages = new Set<number>([1, total]);
  for (let page = current - WINDOW; page <= current + WINDOW; page += 1) {
    if (page >= 1 && page <= total) pages.add(page);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous !== 0 && page - previous > 1) out.push('gap');
    out.push(page);
    previous = page;
  }
  return out;
}

/**
 * Plain links, not a client component: pagination works without JavaScript, is crawlable, and
 * costs nothing in the first render. `rel=prev/next` helps search engines follow the sequence.
 */
export function Pagination({
  basePath,
  params,
  total,
}: {
  basePath: string;
  params: ListParams;
  total: number;
}) {
  const t = useTranslations('plp');
  if (total <= 1) return null;
  const current = Math.min(params.page, total);

  return (
    <nav aria-label={t('pagination')} className="mt-10 flex items-center justify-center gap-1">
      {current > 1 ? (
        <Link
          href={listHref(basePath, { ...params, page: current - 1 })}
          rel="prev"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('previous')}
        </Link>
      ) : null}

      {pageNumbers(current, total).map((page, index) =>
        page === 'gap' ? (
          <span key={`gap-${index}`} className="px-2 text-muted-foreground" aria-hidden="true">
            …
          </span>
        ) : (
          <Link
            key={page}
            href={listHref(basePath, { ...params, page })}
            aria-label={t('page', { page })}
            aria-current={page === current ? 'page' : undefined}
            className={buttonVariants({
              variant: page === current ? 'primary' : 'ghost',
              size: 'sm',
            })}
          >
            {page}
          </Link>
        ),
      )}

      {current < total ? (
        <Link
          href={listHref(basePath, { ...params, page: current + 1 })}
          rel="next"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('next')}
        </Link>
      ) : null}
    </nav>
  );
}

export { pageNumbers };
