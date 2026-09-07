'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/table/data-table';
import type { AdminComponents, AdminError } from '@/lib/api/admin-client';
import type { ReactNode } from 'react';
import type { TableQuery } from '@/lib/table/query-state';
import { STORES_SORTABLE_COLUMNS, STORES_TABLE_DEFAULTS } from './stores-table.config';

type Store = AdminComponents['Store'];

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  paused: 'warning',
  draft: 'neutral',
  archived: 'neutral',
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

/**
 * Columns are typed against the contract schema, so renaming a field in `admin-api.yaml` breaks
 * this file at compile time instead of rendering blanks.
 */
const columns: ColumnDef<Store, unknown>[] = [
  {
    id: 'name',
    header: 'Name',
    accessorKey: 'name',
    cell: ({ row }) => (
      <Link href={`/stores/${row.original.id}`} className="text-accent hover:underline">
        {row.original.name}
      </Link>
    ),
  },
  {
    id: 'code',
    header: 'Code',
    accessorKey: 'code',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.code}</span>,
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
    id: 'currency',
    header: 'Currency',
    accessorKey: 'default_currency',
  },
  {
    id: 'country',
    header: 'Country',
    accessorKey: 'default_country',
  },
  {
    id: 'created_at',
    header: 'Created',
    accessorKey: 'created_at',
    cell: ({ row }) => <span className="text-muted">{formatDate(row.original.created_at)}</span>,
  },
];

export function StoresTable({
  rows,
  total,
  query,
  emptyAction,
  error,
}: {
  rows: readonly Store[];
  total: number;
  query: TableQuery;
  emptyAction?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  return (
    <DataTable<Store>
      columns={columns}
      rows={rows}
      total={total}
      query={query}
      defaults={STORES_TABLE_DEFAULTS}
      getRowId={(store) => store.id}
      caption="Stores"
      sortableColumns={STORES_SORTABLE_COLUMNS}
      emptyAction={emptyAction}
      error={error}
    />
  );
}
