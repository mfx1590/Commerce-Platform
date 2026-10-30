// #648: ClickHouse users, profiles, quotas and grants as versioned SQL (data/clickhouse/access/), applied by
// `ch:migrate` with the admin client on every run. Server-level and idempotent, so — unlike a migration — a file is
// never recorded: it runs again each time and resets its user to exactly what it says (password from the env,
// grants revoked then granted). ClickHouse Cloud ignores users.d / config.d, which is why this exists.
//
// A file is ONE user: `-- user: <name>` and `-- password-env: <VAR>` in its header, `{{user}}`, `{{database}}` and
// `{{password_sha256}}` in its statements. The password never reaches git or the query log: the env value is hashed
// here and every statement runs with log_queries = 0.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertIdentifier, type ChClient } from './clickhouse.js';
import { REPO_ROOT, splitStatements } from './migrations.js';

export const ACCESS_DIR = join(REPO_ROOT, 'data/clickhouse/access');

export interface AccessFile {
  name: string;
  /** the user this file defines (`-- user:`) */
  user: string;
  /** the env variable holding its password (`-- password-env:`) */
  passwordEnv: string;
  sql: string;
}

export function readAccessFiles(dir: string = ACCESS_DIR): AccessFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
      const header = (key: string) => new RegExp(`^-- ${key}: *(\\S+)\\s*$`, 'm').exec(sql)?.[1];
      const user = header('user');
      const passwordEnv = header('password-env');
      if (!user || !passwordEnv)
        throw new Error(
          `${name}: needs "-- user: <name>" and "-- password-env: <VAR>" header lines`,
        );
      return { name, user: assertIdentifier(user), passwordEnv, sql };
    });
}

// What an access file may say: users, profiles and quotas created/altered, grants revoked and granted.
const ALLOWED =
  /^(CREATE USER IF NOT EXISTS|ALTER USER|CREATE SETTINGS PROFILE IF NOT EXISTS|ALTER SETTINGS PROFILE|CREATE QUOTA IF NOT EXISTS|ALTER QUOTA|REVOKE ALL ON \*\.\* FROM|GRANT)\s/i;
// …and never these: dropping, admin rights, passing rights on, the whole server, a literal password.
const FORBIDDEN: [RegExp, string][] = [
  [/\bDROP\b/i, 'DROP'],
  [/\bGRANT\s+ALL\b/i, 'GRANT ALL'],
  [/\bACCESS MANAGEMENT\b|\bROLE ADMIN\b|\bGRANTEES\b/i, 'access management'],
  [/\bWITH GRANT OPTION\b/i, 'WITH GRANT OPTION'],
  [/^GRANT\b.*\bON\s+\*\.\*/i, 'a grant on *.*'],
  [/^GRANT\b.*\bON\s+system\./i, 'a grant on system'],
  [
    /\bIDENTIFIED\b(?!\s+WITH\s+sha256_hash\s+BY\s+'\{\{password_sha256\}\}')/i,
    'a password that is not {{password_sha256}}',
  ],
];

/** Problems in the access files (empty = fine). Checked before anything reaches the server. */
export function lintAccessFiles(files: readonly AccessFile[]): string[] {
  const out: string[] = [];
  for (const f of files)
    splitStatements(f.sql).forEach((s, i) => {
      const at = `access/${f.name} statement ${i + 1}`;
      if (!ALLOWED.test(s)) out.push(`${at}: not an access statement this runner applies`);
      for (const [re, what] of FORBIDDEN) if (re.test(s)) out.push(`${at}: ${what} is not allowed`);
      if (!s.includes('{{user}}')) out.push(`${at}: names its user through {{user}}`);
    });
  return out;
}

export const sha256Hex = (password: string) =>
  createHash('sha256').update(password, 'utf8').digest('hex');

export interface AccessOptions {
  database: string;
  env?: NodeJS.ProcessEnv;
  /** test hook: apply a file to another user name (a throwaway one), e.g. { analytics_ro: 'analytics_test_x_ro' } */
  rename?: Record<string, string>;
  /** production: a missing password is an error, not a skip */
  strict?: boolean;
}

export interface AccessResult {
  applied: { file: string; user: string }[];
  skipped: { file: string; user: string; reason: string }[];
}

export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}

/** Storage of an existing user ('users_xml', 'local_directory', …), undefined when there is none. */
async function storageOf(admin: ChClient, user: string): Promise<string | undefined> {
  const rows = await (
    await admin.query({
      query: 'SELECT storage FROM system.users WHERE name = {u:String}',
      query_params: { u: user },
      format: 'JSONEachRow',
    })
  ).json<{ storage: string }>();
  return rows[0]?.storage;
}

const SQL_STORAGES = new Set(['local_directory', 'replicated']);

export async function applyAccess(
  admin: ChClient,
  files: readonly AccessFile[] = readAccessFiles(),
  opts: AccessOptions,
): Promise<AccessResult> {
  const problems = lintAccessFiles(files);
  if (problems.length > 0)
    throw new AccessError(`refusing to apply access:\n${problems.join('\n')}`);
  const env = opts.env ?? process.env;
  const database = assertIdentifier(opts.database);
  const result: AccessResult = { applied: [], skipped: [] };
  for (const f of files) {
    const user = assertIdentifier(opts.rename?.[f.user] ?? f.user);
    const password = env[f.passwordEnv];
    if (!password) {
      if (opts.strict) throw new AccessError(`${f.name}: ${f.passwordEnv} is not set`);
      result.skipped.push({ file: f.name, user, reason: `${f.passwordEnv} is not set` });
      continue;
    }
    const storage = await storageOf(admin, user);
    if (storage !== undefined && !SQL_STORAGES.has(storage)) {
      // users.d (read-only storage) owns it: SQL cannot alter it, and the XML stays the source until it is removed
      result.skipped.push({
        file: f.name,
        user,
        reason: `defined in ${storage} (users.d), not by SQL`,
      });
      continue;
    }
    const hash = sha256Hex(password);
    for (const statement of splitStatements(f.sql)) {
      const query = statement
        .replaceAll('{{user}}', user)
        .replaceAll('{{database}}', database)
        .replaceAll('{{password_sha256}}', hash);
      await admin.command({ query, clickhouse_settings: { log_queries: 0 } });
    }
    result.applied.push({ file: f.name, user });
  }
  return result;
}
