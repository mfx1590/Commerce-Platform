// In-memory Odoo (#550): a JSON-RPC "server" the real client talks to through its `fetch` seam, so the client's
// request shapes, authentication and fault handling are exercised end to end. It enforces the Odoo rules the sync
// relies on: a move must balance (Σ debit = Σ credit at 2 decimals), every account and the journal must exist and
// belong to the move's company, and `action_post` moves it to `posted`. Credentials are words, never key shapes.
import type { FetchLike } from './odoo-jsonrpc.js';
import type { ErpAccount, ErpCompany, ErpJournal, ErpMove } from './types.js';

export interface MockOdooOptions {
  companies?: { id: number; name: string; currency: string }[];
  /** Accounts per company (code + name); default: our default chart on every company. */
  accounts?: { company_id: number; code: string; name: string }[];
  /** Journals per company (code + name); default: SAL, PSP, REF, SHP, BNK, COGS, TAX on every company. */
  journals?: { company_id: number; code: string; name: string }[];
  db?: string;
  user?: string;
  apiKey?: string;
  /** Test seam: transport failures before the first successful answer. */
  failFirst?: number;
  /** Currencies known to the instance (odoo:init); default EUR active, GBP and USD inactive. */
  currencies?: { id: number; name: string; active: boolean }[];
}

export const MOCK_ODOO_CREDENTIALS = {
  url: 'http://odoo.mock.invalid',
  db: 'mock',
  user: 'accounting-sync',
  apiKey: 'odoo-mock-password-word',
};

export const DEFAULT_MOCK_JOURNALS = [
  ['SAL', 'Sales'],
  ['PSP', 'PSP fees'],
  ['REF', 'Refunds'],
  ['SHP', 'Shipping'],
  ['BNK', 'Bank'],
  ['COGS', 'Cost of goods sold'],
  ['TAX', 'Tax'],
] as const;

export const DEFAULT_MOCK_CHART = [
  ['1000', 'Bank'],
  ['1100', 'PSP clearing'],
  ['1200', 'Accounts receivable'],
  ['2100', 'Carrier payable'],
  ['2200', 'VAT payable'],
  ['2300', 'Contract liability goods'],
  ['2310', 'Contract liability shipping'],
  ['4000', 'Revenue goods'],
  ['4010', 'Revenue shipping'],
  ['4090', 'Refunds and allowances'],
  ['6000', 'Shipping cost'],
  ['6100', 'PSP fees'],
] as const;

interface MockMoveLine {
  id: number;
  account_id: number;
  name: string;
  debit: number;
  credit: number;
}

export interface MockOdooState {
  companies: ErpCompany[];
  accounts: ErpAccount[];
  journals: ErpJournal[];
  moves: (ErpMove & { line_ids: MockMoveLine[] })[];
  currencies: { id: number; name: string; active: boolean }[];
  /** Every `write` the server applied, for assertions (odoo:init must not rewrite a company). */
  writes: { model: string; ids: number[]; values: Record<string, unknown> }[];
  /** Every RPC the server answered, for assertions: service.method on model. */
  calls: string[];
}

export interface MockOdoo {
  fetch: FetchLike;
  state: MockOdooState;
  /** Test seam: make the next `account.move create` fail with this Odoo error name/message. */
  refuseNextCreate(name: string, message: string): void;
  /** Test seam: archive an account so a move on it is refused (what a renamed/removed Odoo account does). */
  archiveAccount(id: number): void;
  /** Test seam: the next `account.move create` is COMMITTED but its answer is lost (HTTP 503) — the #575 retry case. */
  commitThenFailNextCreate(): void;
  /** Test seam: the next `account.move create` fails with HTTP 503 BEFORE Odoo commits anything. */
  failNextCreate(): void;
  /**
   * Test seam (#639): hold every `account.move create` until `release()` — a slow Odoo, so two overlapping sync runs
   * really interleave (both search by ref before either create lands). `waiting()` counts the held creates.
   */
  pauseCreates(): { release(): void; waiting(): number };
  /** Test seam: an accountant cancels this move in Odoo (#591). */
  cancelMove(id: number): void;
}

class OdooFault extends Error {
  constructor(
    public readonly odooName: string,
    message: string,
  ) {
    super(message);
  }
}

export function createMockOdoo(opts: MockOdooOptions = {}): MockOdoo {
  const db = opts.db ?? MOCK_ODOO_CREDENTIALS.db;
  const user = opts.user ?? MOCK_ODOO_CREDENTIALS.user;
  const apiKey = opts.apiKey ?? MOCK_ODOO_CREDENTIALS.apiKey;
  const companies = opts.companies ?? [
    { id: 1, name: 'Brand A B.V.', currency: 'EUR' },
    { id: 2, name: 'Brand B Ltd', currency: 'GBP' },
  ];
  let nextId = 1;
  const state: MockOdooState = {
    companies,
    accounts: (
      opts.accounts ??
      companies.flatMap((c) =>
        DEFAULT_MOCK_CHART.map(([code, name]) => ({ company_id: c.id, code, name })),
      )
    ).map((a) => ({ id: nextId++, ...a })),
    journals: (
      opts.journals ??
      companies.flatMap((c) =>
        DEFAULT_MOCK_JOURNALS.map(([code, name]) => ({ company_id: c.id, code, name })),
      )
    ).map((j) => ({ id: nextId++, ...j })),
    moves: [],
    currencies: opts.currencies ?? [
      { id: 901, name: 'EUR', active: true },
      { id: 902, name: 'GBP', active: false },
      { id: 903, name: 'USD', active: false },
    ],
    writes: [],
    calls: [],
  };
  const archived = new Set<number>();
  let refuse: { name: string; message: string } | null = null;
  let loseNextCreateAnswer = false;
  let failNextCreateUncommitted = false;
  let createGate: { waiters: (() => void)[] } | null = null;
  let failFirst = opts.failFirst ?? 0;
  const uid = 7;

  const asRef = (row: { id: number; name?: string; code?: string }): [number, string] => [
    row.id,
    row.name ?? row.code ?? String(row.id),
  ];

  function matches(row: Record<string, unknown>, domain: unknown[]): boolean {
    for (const term of domain) {
      const [field, op, value] = term as [string, string, unknown];
      const v = row[field];
      const scalar = Array.isArray(v) ? v[0] : v;
      if (op === '=' && scalar !== value) return false;
      if (op === '!=' && scalar === value) return false;
      if (op === 'in' && !(value as unknown[]).includes(scalar)) return false;
    }
    return true;
  }

  function searchRead(
    model: string,
    domain: unknown[],
    fields: string[] | undefined,
    limit?: number,
  ): unknown[] {
    let rows: Record<string, unknown>[];
    switch (model) {
      case 'res.company':
        rows = state.companies.map((c) => ({
          id: c.id,
          name: c.name,
          currency_id: [0, c.currency],
        }));
        break;
      case 'account.account':
        rows = state.accounts
          .filter((a) => !archived.has(a.id))
          .map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            company_id: asRef(state.companies.find((c) => c.id === a.company_id)!),
          }));
        break;
      case 'account.journal':
        rows = state.journals.map((j) => ({
          id: j.id,
          code: j.code,
          name: j.name,
          company_id: asRef(state.companies.find((c) => c.id === j.company_id)!),
        }));
        break;
      case 'account.move':
        rows = state.moves.map((m) => ({
          id: m.id,
          ref: m.ref,
          state: m.state,
          date: m.date,
          journal_id: asRef(state.journals.find((j) => j.id === m.journal_id)!),
          company_id: asRef(state.companies.find((c) => c.id === m.company_id)!),
        }));
        break;
      case 'res.currency':
        rows = state.currencies.map((c) => ({ ...c }));
        break;
      case 'ir.module.module':
        rows = [{ id: 1, name: 'account', state: 'installed' }];
        break;
      default:
        throw new OdooFault('odoo.exceptions.AccessError', `model ${model} is not available`);
    }
    const out = rows.filter((r) => matches(r, domain));
    const limited = limit ? out.slice(0, limit) : out;
    return fields
      ? limited.map((r) => Object.fromEntries(['id', ...fields].map((f) => [f, r[f]])))
      : limited;
  }

  function createMove(values: Record<string, unknown>): number {
    if (refuse) {
      const r = refuse;
      refuse = null;
      throw new OdooFault(r.name, r.message);
    }
    const companyId = values.company_id as number;
    const company = state.companies.find((c) => c.id === companyId);
    if (!company)
      throw new OdooFault('odoo.exceptions.ValidationError', `company ${companyId} does not exist`);
    const journal = state.journals.find((j) => j.id === (values.journal_id as number));
    if (!journal) throw new OdooFault('odoo.exceptions.ValidationError', 'journal does not exist');
    if (journal.company_id !== companyId)
      throw new OdooFault('odoo.exceptions.ValidationError', 'journal belongs to another company');
    const lineCommands = values.line_ids as [number, number, Record<string, unknown>][];
    const lines: MockMoveLine[] = [];
    let debit = 0;
    let credit = 0;
    for (const [, , l] of lineCommands) {
      const account = state.accounts.find((a) => a.id === (l.account_id as number));
      if (!account || archived.has(account.id))
        throw new OdooFault(
          'odoo.exceptions.ValidationError',
          `account ${String(l.account_id)} does not exist`,
        );
      if (account.company_id !== companyId)
        throw new OdooFault(
          'odoo.exceptions.ValidationError',
          'account belongs to another company',
        );
      const d = Number(l.debit ?? 0);
      const c = Number(l.credit ?? 0);
      if (d < 0 || c < 0 || (d > 0 && c > 0))
        throw new OdooFault('odoo.exceptions.ValidationError', 'a line is either debit or credit');
      debit += d;
      credit += c;
      lines.push({
        id: nextId++,
        account_id: account.id,
        name: String(l.name ?? ''),
        debit: d,
        credit: c,
      });
    }
    if (Math.round(debit * 100) !== Math.round(credit * 100)) {
      throw new OdooFault(
        'odoo.exceptions.UserError',
        `cannot create unbalanced journal entry (debit ${debit.toFixed(2)}, credit ${credit.toFixed(2)})`,
      );
    }
    if (lines.length === 0)
      throw new OdooFault('odoo.exceptions.UserError', 'a journal entry needs lines');
    const id = nextId++;
    state.moves.push({
      id,
      state: 'draft',
      company_id: companyId,
      journal_id: journal.id,
      date: String(values.date),
      ref: String(values.ref ?? ''),
      lines: lines.map((l) => ({
        account_id: l.account_id,
        name: l.name,
        debit: l.debit,
        credit: l.credit,
      })),
      line_ids: lines,
    });
    return id;
  }

  function execute(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): unknown {
    state.calls.push(`${model}.${method}`);
    switch (method) {
      case 'search_read':
        return searchRead(
          model,
          (args[0] as unknown[]) ?? [],
          kwargs.fields as string[] | undefined,
          kwargs.limit as number | undefined,
        );
      case 'create': {
        const v = args[0] as Record<string, unknown>;
        if (model === 'account.move') return createMove(v);
        const id = nextId++;
        if (model === 'res.company') {
          const cur = state.currencies.find((c) => c.id === v.currency_id);
          state.companies.push({ id, name: String(v.name), currency: cur?.name ?? '' });
        } else if (model === 'account.account') {
          state.accounts.push({
            id,
            company_id: Number(v.company_id),
            code: String(v.code),
            name: String(v.name),
          });
        } else if (model === 'account.journal') {
          state.journals.push({
            id,
            company_id: Number(v.company_id),
            code: String(v.code),
            name: String(v.name),
          });
        } else
          throw new OdooFault('odoo.exceptions.AccessError', `create on ${model} is not available`);
        return id;
      }
      case 'write': {
        const [ids, values] = args as [number[], Record<string, unknown>];
        state.writes.push({ model, ids, values });
        for (const id of ids) {
          if (model === 'res.currency') {
            const c = state.currencies.find((x) => x.id === id);
            if (c && typeof values.active === 'boolean') c.active = values.active;
          } else if (model === 'res.company') {
            const c = state.companies.find((x) => x.id === id);
            const cur = state.currencies.find((x) => x.id === values.currency_id);
            if (c && cur) c.currency = cur.name;
          } else
            throw new OdooFault(
              'odoo.exceptions.AccessError',
              `write on ${model} is not available`,
            );
        }
        return true;
      }
      case 'action_post': {
        if (model !== 'account.move')
          throw new OdooFault('odoo.exceptions.AccessError', `action_post on ${model}`);
        for (const id of args[0] as number[]) {
          const m = state.moves.find((x) => x.id === id);
          if (!m) throw new OdooFault('odoo.exceptions.MissingError', `move ${id} does not exist`);
          if (m.state !== 'draft')
            throw new OdooFault(
              'odoo.exceptions.UserError',
              'Only draft journal entries can be posted',
            );
          m.state = 'posted';
        }
        return true;
      }
      default:
        throw new OdooFault('odoo.exceptions.AccessError', `${model}.${method} is not available`);
    }
  }

  const fetchImpl: FetchLike = async (url, init) => {
    if (!url.endsWith('/jsonrpc')) return { ok: false, status: 404, json: async () => ({}) };
    if (failFirst > 0) {
      failFirst -= 1;
      return { ok: false, status: 503, json: async () => ({}) };
    }
    const req = JSON.parse(init.body) as {
      id: number;
      params: { service: string; method: string; args: unknown[] };
    };
    const answer = (result: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: req.id, result }),
    });
    const fault = (f: OdooFault) => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: 200,
          message: 'Odoo Server Error',
          data: { name: f.odooName, message: f.message },
        },
      }),
    });
    try {
      const { service, method, args } = req.params;
      if (service === 'db' && method === 'list') {
        state.calls.push('db.list');
        return answer([db]);
      }
      if (service === 'common' && method === 'authenticate') {
        const [d, u, k] = args as [string, string, string];
        state.calls.push('common.authenticate');
        return answer(d === db && u === user && k === apiKey ? uid : false);
      }
      if (service === 'object' && method === 'execute_kw') {
        const [d, u, k, model, m, a, kw] = args as [
          string,
          number,
          string,
          string,
          string,
          unknown[],
          Record<string, unknown> | undefined,
        ];
        if (d !== db || u !== uid || k !== apiKey)
          throw new OdooFault('odoo.exceptions.AccessDenied', 'Access Denied');
        if (model === 'account.move' && m === 'create' && createGate) {
          const gate = createGate;
          await new Promise<void>((resolve) => gate.waiters.push(resolve));
        }
        if (model === 'account.move' && m === 'create' && failNextCreateUncommitted) {
          failNextCreateUncommitted = false; // nothing reached Odoo
          return { ok: false, status: 503, json: async () => ({}) };
        }
        const out = execute(model, m, a ?? [], kw ?? {});
        if (model === 'account.move' && m === 'create' && loseNextCreateAnswer) {
          loseNextCreateAnswer = false; // committed above; the answer never arrives
          return { ok: false, status: 503, json: async () => ({}) };
        }
        return answer(out);
      }
      throw new OdooFault('odoo.exceptions.AccessError', `${service}.${method} is not available`);
    } catch (err) {
      if (err instanceof OdooFault) return fault(err);
      throw err;
    }
  };

  return {
    fetch: fetchImpl,
    state,
    refuseNextCreate(name, message) {
      refuse = { name, message };
    },
    archiveAccount(id) {
      archived.add(id);
    },
    commitThenFailNextCreate() {
      loseNextCreateAnswer = true;
    },
    pauseCreates() {
      const gate = { waiters: [] as (() => void)[] };
      createGate = gate;
      return {
        release() {
          if (createGate === gate) createGate = null;
          for (const w of gate.waiters.splice(0)) w();
        },
        waiting: () => gate.waiters.length,
      };
    },
    failNextCreate() {
      failNextCreateUncommitted = true;
    },
    cancelMove(id) {
      const m = state.moves.find((x) => x.id === id);
      if (!m) throw new Error(`mock: no move ${id}`);
      m.state = 'cancel';
    },
  };
}
