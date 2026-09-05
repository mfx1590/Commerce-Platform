'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/table/data-table';
import type { AdminComponents, AdminError } from '@/lib/api/admin-client';
import type { TableQuery } from '@/lib/table/query-state';

type Store = AdminComponents['Store'];

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  paused: 'warning',
  draft: 'neutral',
  archived: 'neutral',
};

/**
 * Columns are typed against the contract schema, so renaming a field in `admin-api.yaml` breaks
 * this file at compile time instead of rendering blanks.
 */
const columns: ColumnDef<Store, unknown>[] = [
  {
    id: 'name',
    header: 'Name',
    accessorKey: 'name',
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
];

export function StoresTable({
  rows,
  total,
  query,
  error,
}: {
  rows: readonly Store[];
  total: number;
  query: TableQuery;
  error?: { status: number; error: AdminError } | undefined;
}) {
  return (
    <DataTable<Store>
      columns={columns}
      rows={rows}
      total={total}
      query={query}
      getRowId={(store) => store.id}
      caption="Stores"
      // No sortable columns yet: contracts-v0.1 has no sort parameter (CONTRACT CHANGE #56).
      // Adding one here plus `sortable: true` in the API wrapper is all it takes once that lands.
      sortableColumns={[]}
      error={error}
    />
  );
}
