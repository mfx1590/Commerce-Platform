// ERP sync (#550): the adapter the sync loop talks to, implemented by the Odoo JSON-RPC client and by the in-memory
// mock. Odoo's model: one `account.move` per journal entry (company, journal, date, ref, lines with account, debit,
// credit in currency units), posted once created. Our idempotency key on the Odoo side is `ref`.

export interface ErpCompany {
  id: number;
  name: string;
  /** ISO-4217 of the company's accounting currency. */
  currency: string;
}

export interface ErpAccount {
  id: number;
  code: string;
  name: string;
  company_id: number;
}

export interface ErpJournal {
  id: number;
  code: string;
  name: string;
  company_id: number;
}

export interface ErpMoveLine {
  account_id: number;
  /** Label of the line: our account code and name, never a payload field. */
  name: string;
  /** Currency units (Odoo uses floats): 136.65 for 13665 minor at 2 decimals. */
  debit: number;
  credit: number;
}

export interface ErpMoveInput {
  company_id: number;
  journal_id: number;
  /** YYYY-MM-DD */
  date: string;
  /** The idempotency key: `<source_event_id>/<journal>`. */
  ref: string;
  lines: ErpMoveLine[];
}

export interface ErpMove extends ErpMoveInput {
  id: number;
  /** Odoo's account.move state; `cancel` = an accountant cancelled it: never re-posted, never marked (#591). */
  state: 'draft' | 'posted' | 'cancel';
}

/** What the sync needs from an ERP. Every method may throw an `ErpError` (class in `name`, no payload in the message). */
export interface ErpAdapter {
  readonly name: string;
  listCompanies(): Promise<ErpCompany[]>;
  listAccounts(companyId: number): Promise<ErpAccount[]>;
  listJournals(companyId: number): Promise<ErpJournal[]>;
  /** The move with this ref in this company, if one exists (search before create). */
  findMoveByRef(companyId: number, ref: string): Promise<ErpMove | null>;
  /** Creates AND posts the move; the ERP refuses an unbalanced move, an unknown account or journal, a company mismatch. */
  createMove(input: ErpMoveInput): Promise<ErpMove>;
  /** Posts a draft move (a posted one is left alone): the recovery for a crash between create and post. */
  postMove(moveId: number): Promise<ErpMove>;
}

/** Errors the ERP side raises: `name` is the class the report carries; the message holds ids and amounts only. */
export class ErpError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** Minor units → currency units for Odoo's float fields (JPY and friends have 0 decimals). */
export const CURRENCY_DECIMALS: Record<string, number> = { JPY: 0, KRW: 0, HUF: 0, ISK: 0 };
export function toCurrencyUnits(minor: number, currency: string): number {
  const d = CURRENCY_DECIMALS[currency] ?? 2;
  return Number((minor / 10 ** d).toFixed(d));
}
