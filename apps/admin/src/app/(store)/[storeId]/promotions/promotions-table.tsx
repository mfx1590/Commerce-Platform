'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/table/data-table';
import type { AdminError } from '@/lib/api/admin-client';
import type { PromotionRow } from '@/lib/promotions/projection';
import type { TableQuery } from '@/lib/table/query-state';
import {
  PROMOTIONS_SORTABLE_COLUMNS,
  PROMOTIONS_TABLE_DEFAULTS,
  promotionTone,
} from './promotions-table.config';

function formatDate(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

/** The promotions list: `PromotionRow` projections with the value already described per type. */
export function PromotionsTable({
  storeId,
  rows,
  total,
  query,
  emptyState,
  error,
}: {
  storeId: string;
  rows: readonly PromotionRow[];
  total: number;
  query: TableQuery;
  emptyState?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  const columns: ColumnDef<PromotionRow, unknown>[] = [
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      cell: ({ row }) => (
        <Link
          href={`/${storeId}/promotions/${row.original.id}`}
          className="text-accent hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: 'code',
      header: 'Code',
      accessorKey: 'code',
      cell: ({ row }) =>
        row.original.code === null ? (
          <span className="text-muted">automatic</span>
        ) : (
          <span className="font-mono text-xs">{row.original.code}</span>
        ),
    },
    {
      id: 'value',
      header: 'Value',
      cell: ({ row }) => (
        <span>
          {row.original.value_label}
          <span className="text-muted text-xs"> · {row.original.type.replaceAll('_', ' ')}</span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      cell: ({ row }) => (
        <Badge tone={promotionTone(row.original.status)}>{row.original.status}</Badge>
      ),
    },
    {
      id: 'starts_at',
      header: 'Schedule',
      accessorKey: 'starts_at',
      cell: ({ row }) => (
        <span className="text-muted font-mono text-xs">
          {formatDate(row.original.starts_at)} → {formatDate(row.original.ends_at)}
        </span>
      ),
    },
    {
      id: 'usage',
      header: 'Uses',
      cell: ({ row }) => (
        <span className="font-mono">
          {row.original.usage_count}
          {row.original.usage_limit === null ? '' : ` / ${row.original.usage_limit}`}
        </span>
      ),
    },
    {
      id: 'flags',
      header: 'Combines',
      cell: ({ row }) =>
        row.original.exclusive ? (
          <Badge tone="warning">exclusive</Badge>
        ) : row.original.stackable ? (
          <Badge tone="accent">stackable</Badge>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ];

  return (
    <DataTable<PromotionRow>
      columns={columns}
      rows={rows}
      total={total}
      query={query}
      defaults={PROMOTIONS_TABLE_DEFAULTS}
      getRowId={(promotion) => promotion.id}
      caption="Promotions"
      sortableColumns={PROMOTIONS_SORTABLE_COLUMNS}
      emptyState={emptyState}
      error={error}
    />
  );
}
