'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { BulkAction } from '@/components/table/bulk-action';
import { DataTable } from '@/components/table/data-table';
import { bulkArchiveProductsAction, bulkPublishProductsAction } from '@/app/actions/bulk-catalog';
import type { AdminComponents, AdminError } from '@/lib/api/admin-client';
import type { ReactNode } from 'react';
import type { TableQuery } from '@/lib/table/query-state';
import { PRODUCTS_SORTABLE_COLUMNS, PRODUCTS_TABLE_DEFAULTS } from './products-table.config';

type Product = AdminComponents['Product'];

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning'> = {
  published: 'success',
  draft: 'neutral',
  archived: 'warning',
};

function formatDate(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

export function ProductsTable({
  storeId,
  rows,
  total,
  query,
  emptyAction,
  error,
  canPublish = false,
  canArchive = false,
}: {
  storeId: string;
  /** Offer bulk Publish (store_staff) / Archive (store_admin). A convenience: the server decides. */
  canPublish?: boolean;
  canArchive?: boolean;
  rows: readonly Product[];
  total: number;
  query: TableQuery;
  /** Shown when the store has no products at all — not when a filter matched nothing. */
  emptyAction?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  const columns: ColumnDef<Product, unknown>[] = [
    {
      id: 'title',
      header: 'Title',
      accessorKey: 'title',
      cell: ({ row }) => (
        <Link
          href={`/${storeId}/catalog/${row.original.id}`}
          className="text-accent hover:underline"
        >
          {row.original.title}
        </Link>
      ),
    },
    {
      id: 'handle',
      header: 'Handle',
      accessorKey: 'handle',
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.handle}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      cell: ({ row }) => (
        <Badge tone={STATUS_TONE[row.original.status] ?? 'neutral'}>{row.original.status}</Badge>
      ),
    },
    {
      id: 'variants',
      header: 'Variants',
      cell: ({ row }) => row.original.variants.length,
    },
    {
      id: 'published_at',
      header: 'Published',
      cell: ({ row }) => (
        <span className="text-muted">{formatDate(row.original.published_at)}</span>
      ),
    },
    {
      id: 'updated_at',
      header: 'Updated',
      cell: ({ row }) => <span className="text-muted">{formatDate(row.original.updated_at)}</span>,
    },
  ];

  return (
    <DataTable<Product>
      columns={columns}
      rows={rows}
      total={total}
      query={query}
      defaults={PRODUCTS_TABLE_DEFAULTS}
      getRowId={(product) => product.id}
      caption="Products"
      sortableColumns={PRODUCTS_SORTABLE_COLUMNS}
      searchKey="q"
      searchPlaceholder="Title or handle"
      emptyAction={emptyAction}
      error={error}
      {...(canPublish || canArchive
        ? {
            bulkActions: (selection, { clear }) => (
              <>
                {canPublish && (
                  <BulkAction
                    label="Publish"
                    noun={{ one: 'product', many: 'products' }}
                    selection={selection}
                    filters={query.filters}
                    run={(sent) => bulkPublishProductsAction(storeId, sent)}
                    onClose={clear}
                    question={(_, words) => `Publish ${words}? Each becomes visible in the store.`}
                  />
                )}
                {canArchive && (
                  <BulkAction
                    label="Archive…"
                    noun={{ one: 'product', many: 'products' }}
                    selection={selection}
                    filters={query.filters}
                    run={(sent) => bulkArchiveProductsAction(storeId, sent)}
                    onClose={clear}
                    destructive
                    question={(_, words) =>
                      `Archive ${words}? They leave the store; the Admin API has no "unarchive".`
                    }
                  />
                )}
              </>
            ),
          }
        : {})}
    />
  );
}
