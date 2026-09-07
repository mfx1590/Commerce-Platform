import { Button, Input, buttonVariants } from '@platform/ui';
import Link from 'next/link';
import { cn } from '@platform/ui';
import {
  listHref,
  SORT_OPTIONS,
  type CategoryNode,
  type ListParams,
  type Sort,
} from '@/lib/catalog';

const SORT_LABELS: Record<Sort, string> = {
  relevance: 'Relevance',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  newest: 'Newest',
};

/**
 * Filters are links and a GET form — no client component, no JavaScript needed, and every filtered
 * view has its own URL that can be shared, bookmarked and crawled.
 */
export function SortLinks({ basePath, params }: { basePath: string; params: ListParams }) {
  return (
    <nav aria-label="Sort by" className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Sort</span>
      {SORT_OPTIONS.map((sort) => (
        <Link
          key={sort}
          href={listHref(basePath, { ...params, sort, page: 1 })}
          aria-current={sort === params.sort ? 'true' : undefined}
          className={buttonVariants({
            variant: sort === params.sort ? 'secondary' : 'ghost',
            size: 'sm',
          })}
        >
          {SORT_LABELS[sort]}
        </Link>
      ))}
    </nav>
  );
}

export function SearchForm({ basePath, params }: { basePath: string; params: ListParams }) {
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
        placeholder="Search products"
        aria-label="Search products"
        className="max-w-xs"
      />
      <Button type="submit" variant="outline">
        Search
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
  if (categories.length === 0) return null;

  return (
    <nav aria-label="Categories" className="flex flex-col gap-2 text-sm">
      <h2 className="font-semibold">Categories</h2>
      <Link
        href={listHref(basePath, { ...params, category: undefined, page: 1 })}
        className={cn('hover:underline', activeHandle === undefined && 'font-medium underline')}
      >
        All products
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
