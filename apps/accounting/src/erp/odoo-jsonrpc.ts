// Odoo JSON-RPC client (#550, crash cases #575): `POST /jsonrpc` with `{ jsonrpc: '2.0', method: 'call', params:
// { service, method, args }, id }`. `common.authenticate(db, login, api_key, {})` → uid; `object.execute_kw(db, uid,
// api_key, model, method, args, kwargs)` for everything else; `db.*` for the database service (odoo:init). Credentials
// come from the environment only (ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY); they never appear in a log line or an
// error message. Bounded timeouts; bounded retries on transport failures for READS only — a write is never blind-retried
// (Odoo may have committed it before the answer was lost; `createMove` searches by ref instead), and an Odoo fault (a
// refused move) is never retried.
import {
  ErpError,
  type ErpAccount,
  type ErpAdapter,
  type ErpCompany,
  type ErpJournal,
  type ErpMove,
  type ErpMoveInput,
} from './types.js';

export interface OdooCredentials {
  url: string;
  db: string;
  user: string;
  apiKey: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OdooClientOptions {
  /** Default: the global fetch. The mock server passes its own. */
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Transport retries for reads (network error, HTTP 5xx). Default 2. Writes are never retried. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CallOptions {
  /** false = one attempt only (every write). Default true for reads. */
  retry?: boolean;
}

interface RpcFault {
  code: number;
  message: string;
  data?: { name?: string; message?: string; debug?: string };
}

type Service = 'common' | 'object' | 'db';

/** Reads the credentials from the environment; throws when one is missing (the CLI reports which name). */
export function odooCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): OdooCredentials {
  const missing = ['ODOO_URL', 'ODOO_DB', 'ODOO_USER', 'ODOO_API_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new ErpError('OdooNotConfigured', `missing ${missing.join(', ')}`);
  return { url: env.ODOO_URL!, db: env.ODOO_DB!, user: env.ODOO_USER!, apiKey: env.ODOO_API_KEY! };
}

export class OdooJsonRpcClient implements ErpAdapter {
  readonly name = 'odoo';
  private uid: number | null = null;
  private nextId = 1;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly creds: OdooCredentials,
    opts: OdooClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One JSON-RPC call; transport failures retried with backoff (reads only), Odoo faults thrown as ErpError at once. */
  async call(
    service: Service,
    method: string,
    args: unknown[],
    opts: CallOptions = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id,
    });
    const url = `${this.creds.url.replace(/\/$/, '')}/jsonrpc`;
    const maxAttempts = opts.retry === false ? 1 : this.retries + 1;
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status >= 500) throw new ErpError('OdooTransport', `HTTP ${res.status}`);
          throw new ErpError('OdooHttp', `HTTP ${res.status}`);
        }
        const payload = (await res.json()) as { result?: unknown; error?: RpcFault };
        if (payload.error) {
          const data = payload.error.data;
          throw new ErpError(
            faultClass(data?.name, data?.message ?? payload.error.message),
            data?.message ?? payload.error.message,
          );
        }
        return payload.result;
      } catch (err) {
        const transport = !(err instanceof ErpError) || err.name === 'OdooTransport';
        if (!transport) throw err;
        if (attempt >= maxAttempts) {
          if (err instanceof ErpError) throw err;
          const name = (err as Error)?.name === 'AbortError' ? 'OdooTimeout' : 'OdooTransport';
          throw new ErpError(
            name,
            `jsonrpc ${service}.${method} failed after ${attempt} attempt(s)`,
          );
        }
        await this.sleep(200 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async authenticate(): Promise<number> {
    if (this.uid !== null) return this.uid;
    const uid = await this.call('common', 'authenticate', [
      this.creds.db,
      this.creds.user,
      this.creds.apiKey,
      {},
    ]);
    if (typeof uid !== 'number' || uid <= 0)
      throw new ErpError('OdooAuthFailed', 'authentication refused');
    this.uid = uid;
    return uid;
  }

  /** `object.execute_kw`; pass `{ retry: false }` for anything that writes. */
  async executeKw(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
    opts: CallOptions = {},
  ): Promise<unknown> {
    const uid = await this.authenticate();
    return this.call(
      'object',
      'execute_kw',
      [this.creds.db, uid, this.creds.apiKey, model, method, args, kwargs],
      opts,
    );
  }

  // ---- the database service (odoo:init) -----------------------------------------------------------------------

  async listDatabases(): Promise<string[]> {
    return (await this.call('db', 'list', [])) as string[];
  }

  /** Creates the database with the admin user (no demo data, en_US). Slow (a minute or more). Never retried. */
  async createDatabase(masterPassword: string, countryCode: string | false = false): Promise<void> {
    await this.call(
      'db',
      'create_database',
      [
        masterPassword,
        this.creds.db,
        false,
        'en_US',
        this.creds.apiKey,
        this.creds.user,
        countryCode,
      ],
      { retry: false },
    );
  }

  // ---- the adapter --------------------------------------------------------------------------------------------

  async listCompanies(): Promise<ErpCompany[]> {
    const rows = (await this.executeKw('res.company', 'search_read', [[]], {
      fields: ['id', 'name', 'currency_id'],
    })) as { id: number; name: string; currency_id: [number, string] | false }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      currency: r.currency_id ? r.currency_id[1] : '',
    }));
  }

  async listAccounts(companyId: number): Promise<ErpAccount[]> {
    const rows = (await this.executeKw(
      'account.account',
      'search_read',
      [[['company_id', '=', companyId]]],
      {
        fields: ['id', 'code', 'name', 'company_id'],
      },
    )) as { id: number; code: string; name: string; company_id: [number, string] }[];
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, company_id: r.company_id[0] }));
  }

  async listJournals(companyId: number): Promise<ErpJournal[]> {
    const rows = (await this.executeKw(
      'account.journal',
      'search_read',
      [[['company_id', '=', companyId]]],
      {
        fields: ['id', 'code', 'name', 'company_id'],
      },
    )) as { id: number; code: string; name: string; company_id: [number, string] }[];
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, company_id: r.company_id[0] }));
  }

  /**
   * The move with this ref in this company, if one exists (search before create). Several moves can share a ref (an
   * accountant cancelled ours and entered it again): a posted one wins, then a draft, then a cancelled one, oldest
   * first within each state. A cancelled move is returned only when nothing else has the ref (#591).
   */
  async findMoveByRef(companyId: number, ref: string): Promise<ErpMove | null> {
    const rows = (await this.executeKw(
      'account.move',
      'search_read',
      [
        [
          ['company_id', '=', companyId],
          ['ref', '=', ref],
        ],
      ],
      {
        fields: ['id', 'ref', 'state', 'date', 'journal_id', 'company_id'],
        order: 'id asc',
      },
    )) as {
      id: number;
      ref: string;
      state: 'draft' | 'posted' | 'cancel';
      date: string;
      journal_id: [number, string];
      company_id: [number, string];
    }[];
    const rank = { posted: 0, draft: 1, cancel: 2 } as const;
    const r = [...rows].sort((a, b) => rank[a.state] - rank[b.state] || a.id - b.id)[0];
    if (!r) return null;
    return {
      id: r.id,
      ref: r.ref,
      state: r.state,
      date: r.date,
      journal_id: r.journal_id[0],
      company_id: r.company_id[0],
      lines: [],
    };
  }

  /** Posts a draft move (idempotent: a posted move is left alone). A cancelled move is refused, never re-posted. */
  async postMove(moveId: number): Promise<ErpMove> {
    const rows = (await this.executeKw('account.move', 'search_read', [[['id', '=', moveId]]], {
      fields: ['id', 'ref', 'state', 'date', 'journal_id', 'company_id'],
    })) as {
      id: number;
      ref: string;
      state: 'draft' | 'posted' | 'cancel';
      date: string;
      journal_id: [number, string];
      company_id: [number, string];
    }[];
    const r = rows[0];
    if (!r) throw new ErpError('OdooMoveMissing', `move ${moveId} does not exist`);
    if (r.state === 'cancel')
      throw new ErpError(
        'OdooMoveCancelled',
        `move ${moveId} was cancelled in Odoo; it is not re-posted`,
      );
    if (r.state !== 'posted')
      await this.executeKw('account.move', 'action_post', [[moveId]], {}, { retry: false });
    return {
      id: r.id,
      ref: r.ref,
      state: 'posted',
      date: r.date,
      journal_id: r.journal_id[0],
      company_id: r.company_id[0],
      lines: [],
    };
  }

  /**
   * Creates AND posts the move. The create is sent ONCE: when its answer is lost (timeout, 5xx), Odoo may have committed
   * it, so the client searches by ref instead of retrying — a found move (draft or posted) is used, nothing found
   * rethrows the transport error for the next run. A draft found after a crash between create and post is posted.
   */
  async createMove(input: ErpMoveInput): Promise<ErpMove> {
    let id: number;
    try {
      id = (await this.executeKw(
        'account.move',
        'create',
        [
          {
            move_type: 'entry',
            company_id: input.company_id,
            journal_id: input.journal_id,
            date: input.date,
            ref: input.ref,
            line_ids: input.lines.map((l) => [
              0,
              0,
              { account_id: l.account_id, name: l.name, debit: l.debit, credit: l.credit },
            ]),
          },
        ],
        {},
        { retry: false },
      )) as number;
    } catch (err) {
      if (
        !(err instanceof ErpError) ||
        (err.name !== 'OdooTransport' && err.name !== 'OdooTimeout')
      )
        throw err;
      const existing = await this.findMoveByRef(input.company_id, input.ref);
      if (!existing) throw err;
      id = existing.id;
    }
    const posted = await this.postMove(id);
    return { ...input, id, state: posted.state };
  }
}

/** Odoo's fault names → our classes (the message is kept out of the class). */
function faultClass(name: string | undefined, message: string): string {
  const n = name ?? '';
  const m = message;
  if (/AccessDenied|AccessError/.test(n)) return 'OdooAccessDenied';
  if (/balanced|unbalanced/i.test(m)) return 'OdooUnbalancedMove';
  if (/account/i.test(m) && /(not found|missing|does not exist|unknown)/i.test(m))
    return 'OdooAccountMissing';
  if (/journal/i.test(m) && /(not found|missing|does not exist|unknown)/i.test(m))
    return 'OdooJournalMissing';
  if (/company/i.test(m)) return 'OdooCompanyMismatch';
  if (/MissingError/.test(n)) return 'OdooMoveMissing';
  if (/ValidationError|UserError/.test(n)) return 'OdooValidationError';
  return 'OdooFault';
}
