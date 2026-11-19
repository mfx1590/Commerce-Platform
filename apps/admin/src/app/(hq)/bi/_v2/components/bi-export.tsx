'use client';

import { ExportCsvButton } from '@/components/table/export-csv';
import { exportBiCsvAction, type BiBlock } from '../actions';

/**
 * "Export CSV" of one BI v2 block. The server action rebuilds the block's query from the same URL
 * state and checks the BI section before asking the API for its CSV (label columns included).
 */
export function BiExport({
  block,
  params,
  storeId,
  what,
  cap,
}: {
  block: BiBlock;
  params: Record<string, string>;
  storeId: string | null;
  what: string;
  /** The most rows the file holds (the API's cap for this block). */
  cap: number;
}) {
  return (
    <ExportCsvButton what={what} cap={cap} run={() => exportBiCsvAction(block, params, storeId)} />
  );
}
