// #648 follow-up 3: `ch:migrate` must know WHICH ClickHouse admin it is. Unset, loadConfig would fall back to the
// `default` user silently (and on the shared stack that is not the admin: the access step then fails or, worse, the
// migration runs as someone else). So: when CLICKHOUSE_USER is absent, the repo-root `.env` is loaded (never over a
// variable that is already set: CI and deploys pass theirs explicitly); still absent → a clear refusal.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export type AdminEnv =
  { ok: true; source: 'environment' | '.env' } | { ok: false; message: string };

export function resolveAdminEnv(env: NodeJS.ProcessEnv, repoRoot: string): AdminEnv {
  if (env.CLICKHOUSE_USER?.trim()) return { ok: true, source: 'environment' };
  const file = join(repoRoot, '.env');
  if (existsSync(file)) {
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (env[k] === undefined) env[k] = v;
    if (env.CLICKHOUSE_USER?.trim()) return { ok: true, source: '.env' };
  }
  return {
    ok: false,
    message:
      'CLICKHOUSE_USER is not set (neither in the environment nor in the repo-root .env): ch:migrate runs as the ' +
      'ClickHouse ADMIN and refuses to guess one (it would otherwise connect as `default`). Set CLICKHOUSE_USER / ' +
      'CLICKHOUSE_PASSWORD, or copy .env.example to .env.',
  };
}
