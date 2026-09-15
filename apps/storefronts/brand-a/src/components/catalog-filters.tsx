import { Button, Input, buttonVariants, cn } from '@platform/ui';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  listHref,
  SORT_OPTIONS,
  type CategoryNode,
  type ListParams,
  type Sort,
} from '@/lib/catalog';

/**
 * Filters are links and a GET form — no client component, no JavaScript needed, and every filtered
 * view has its own URL that can be shared, bookmarked and crawled.
 */
export function SortLinks({ basePath, params }: { basePath: string; params: ListParams }) {
  const t = useTranslations('plp');

  return (
    <nav aria-label={t('sort')} className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">{t('sort')}</span>
      {SORT_OPTIONS.map((sort: Sort) => (
        <Link
          key={sort}
          href={listHref(basePath, { ...params, sort, page: 1 })}
          aria-current={sort === params.sort ? 'true' : undefined}
          className={buttonVariants({
            variant: sort === params.sort ? 'secondary' : 'ghost',
            size: 'sm',
          })}
        >
          {t(`sortOptions.${sort}`)}
        </Link>
      ))}
    </nav>
  );
}

export function SearchForm({ basePath, params }: { basePath: string; params: ListParams }) {
  const t = useTranslations('plp');

  return (
    <form method="get" action={basePath} role="search" className="flex gap-2">
      {params.category === undefined ? null : (
        <input type="hidden" name="category" value={params.category} />
      )}
      {params.sort === 'relevance' ? null : <input type="hidden" name="sort" value={params.sort} />}
      <Input
        type="search"
        name="q"
        defaultValue={params.q ?? ''}
        placeholder={t('search')}
        aria-label={t('search')}
        className="max-w-xs"
      />
      <Button type="submit" variant="outline">
        {t('searchAction')}
      </Button>
    </form>
  );
}

export function CategoryFilter({
  basePath,
  params,
  categories,
  activeHandle,
}: {
  basePath: string;
  params: ListParams;
  categories: CategoryNode[];
  activeHandle?: string | undefined;
}) {
  const t = useTranslations('plp');
  if (categories.length === 0) return null;

  return (
    <nav aria-label={t('categories')} className="flex flex-col gap-2 text-sm">
      <h2 className="font-semibold">{t('categories')}</h2>
      <Link
        href={listHref(basePath, { ...params, category: undefined, page: 1 })}
        className={cn('hover:underline', activeHandle === undefined && 'font-medium underline')}
      >
        {t('allProducts')}
      </Link>
      <ul className="flex flex-col gap-2">
        {categories.map((category) => (
          <li key={category.id}>
            <CategoryLink category={category} activeHandle={activeHandle} />
            {category.children.length === 0 ? null : (
              <ul className="ml-4 mt-2 flex flex-col gap-2 border-l border-border pl-3">
                {category.children.map((child) => (
                  <li key={child.id}>
                    <CategoryLink category={child} activeHandle={activeHandle} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function CategoryLink({
  category,
  activeHandle,
}: {
  category: CategoryNode;
  activeHandle?: string | undefined;
}) {
  const active = category.handle === activeHandle;
  return (
    <Link
      href={`/categories/${category.handle}`}
      aria-current={active ? 'page' : undefined}
      className={cn('hover:underline', active && 'font-medium underline')}
    >
      {category.name}
    </Link>
  );
}
