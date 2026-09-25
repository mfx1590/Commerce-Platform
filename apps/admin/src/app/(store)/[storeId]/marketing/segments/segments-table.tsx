'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DataTable } from '@/components/table/data-table';
import type { AdminComponents, AdminError } from '@/lib/api/admin-client';
import type { TableQuery } from '@/lib/table/query-state';
import { SEGMENTS_SORTABLE_COLUMNS, SEGMENTS_TABLE_DEFAULTS } from './segments-table.config';

type Segment = AdminComponents['Segment'];

function formatWhen(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

export function SegmentsTable({
  storeId,
  rows,
  total,
  query,
  emptyAction,
  error,
}: {
  storeId: string;
  rows: readonly Segment[];
  total: number;
  query: TableQuery;
  emptyAction?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  const columns: ColumnDef<Segment, unknown>[] = [
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      cell: ({ row }) => (
        <Link
          href={`/${storeId}/marketing/segments/${row.original.id}`}
          className="text-accent hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: 'description',
      header: 'Description',
      accessorKey: 'description',
      cell: ({ row }) => (
        <span className="text-muted text-xs">{row.original.description ?? '—'}</span>
      ),
    },
    {
      id: 'materialised_count',
      header: 'Members',
      accessorKey: 'materialised_count',
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">{row.original.materialised_count}</span>
      ),
    },
    {
      id: 'last_materialised_at',
      header: 'Last refreshed',
      accessorKey: 'last_materialised_at',
      // "never" is the useful word here: a segment that was never materialised has no members to send to,
      // however good its rules are.
      cell: ({ row }) => (
        <span className="font-mono text-xs">{formatWhen(row.original.last_materialised_at)}</span>
      ),
    },
  ];

  return (
    <DataTable<Segment>
      columns={columns}
      rows={rows}
      total={total}
      query={query}
      defaults={SEGMENTS_TABLE_DEFAULTS}
      getRowId={(row) => row.id}
      caption="Segments"
      sortableColumns={SEGMENTS_SORTABLE_COLUMNS}
      {...(emptyAction === undefined ? {} : { emptyAction })}
      {...(error === undefined ? {} : { error })}
    />
  );
}
