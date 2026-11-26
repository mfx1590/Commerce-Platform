'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/table/data-table';
import { useTermSearch } from '@/components/table/use-term-search';
import { searchCustomersAction } from '@/app/actions/search-lists';
import type { AdminError } from '@/lib/api/admin-client';
import type { CustomerRow } from '@/lib/customers/projection';
import type { TableQuery } from '@/lib/table/query-state';
import {
  CUSTOMERS_SORTABLE_COLUMNS,
  CUSTOMERS_TABLE_DEFAULTS,
  customerTone,
  displayName,
} from './customers-table.config';

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

/**
 * The customers list. Rows are personal data: this component receives `CustomerRow` projections
 * — exactly the columns it renders, the consent already summarised, no phone, no identity id, no
 * raw consent (`src/lib/customers/projection.ts`) — renders them as text, and never logs or
 * forwards them anywhere. The full `Customer` does not typecheck as a row.
 *
 * #946: the "Email or name" search is POST-backed (`searchCustomersAction`). The typed term never enters
 * the URL, so a customer's email does not land in browser history; the rows shown while searching are the
 * action's answer. The group filter, page size and sort stay in the URL as before.
 */
export function CustomersTable({
  storeId,
  rows,
  total,
  query,
  groupNames = {},
  emptyState,
  error,
}: {
  storeId: string;
  rows: readonly CustomerRow[];
  total: number;
  query: TableQuery;
  /** Group id → name, resolved on the server. Names are not personal data; ids alone are useless. */
  groupNames?: Readonly<Record<string, string>>;
  emptyState?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  const search = useTermSearch<CustomerRow>({
    query,
    run: (term, request) => searchCustomersAction(storeId, term, request),
  });
  const columns: ColumnDef<CustomerRow, unknown>[] = [
    {
      id: 'email',
      header: 'Email',
      accessorKey: 'email',
      cell: ({ row }) => (
        <Link
          href={`/${storeId}/customers/${row.original.id}`}
          className="text-accent break-all hover:underline"
        >
          {row.original.email}
        </Link>
      ),
    },
    {
      id: 'last_name',
      header: 'Name',
      accessorKey: 'last_name',
      cell: ({ row }) => displayName(row.original),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge tone={customerTone(row.original.status)}>{row.original.status}</Badge>
      ),
    },
    {
      id: 'consent',
      header: 'Consent',
      cell: ({ row }) => <span className="text-muted">{row.original.consent_summary}</span>,
    },
    {
      id: 'group',
      header: 'Group',
      cell: ({ row }) => {
        const id = row.original.customer_group_id;
        if (id === null) return <span className="text-muted">—</span>;
        const name = Object.hasOwn(groupNames, id) ? groupNames[id] : undefined;
        // A group the picker could not name (a failed read, or one removed since) keeps its id
        // rather than reading as "no group".
        return name === undefined ? (
          <span className="text-muted font-mono text-xs">{id.slice(0, 8)}…</span>
        ) : (
          <span>{name}</span>
        );
      },
    },
    {
      id: 'created_at',
      header: 'Since',
      accessorKey: 'created_at',
      cell: ({ row }) => <span className="text-muted">{formatDate(row.original.created_at)}</span>,
    },
  ];

  return (
    <DataTable<CustomerRow>
      columns={columns}
      rows={search.rows ?? rows}
      total={search.total ?? total}
      query={search.query}
      defaults={CUSTOMERS_TABLE_DEFAULTS}
      getRowId={(customer) => customer.id}
      caption="Customers"
      sortableColumns={CUSTOMERS_SORTABLE_COLUMNS}
      searchKey="q"
      searchPlaceholder="Email or name"
      termSearch={search.control}
      emptyState={emptyState}
      error={search.control.term === null ? error : search.error}
    />
  );
}
