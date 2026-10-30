// #648 follow-up 3: ch:migrate never guesses its ClickHouse admin.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAdminEnv } from './admin-env.js';

const dirs: string[] = [];
const repo = (envFile?: string) => {
  const d = mkdtempSync(join(tmpdir(), 'admin-env-'));
  dirs.push(d);
  if (envFile !== undefined) writeFileSync(join(d, '.env'), envFile);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveAdminEnv', () => {
  it('takes CLICKHOUSE_USER from the environment and reads no file', () => {
    const env: NodeJS.ProcessEnv = { CLICKHOUSE_USER: 'from-env' };
    expect(resolveAdminEnv(env, repo('CLICKHOUSE_USER=from-file\n'))).toEqual({
      ok: true,
      source: 'environment',
    });
    expect(env.CLICKHOUSE_USER).toBe('from-env');
  });

  it('absent from the environment: loads the repo-root .env, never over a variable already set', () => {
    const env: NodeJS.ProcessEnv = { CLICKHOUSE_DATABASE: 'kept' };
    const r = resolveAdminEnv(
      env,
      repo(
        'CLICKHOUSE_USER=admin-word\nCLICKHOUSE_PASSWORD=pw-word\nCLICKHOUSE_DATABASE=from-file\n',
      ),
    );
    expect(r).toEqual({ ok: true, source: '.env' });
    expect(env).toMatchObject({
      CLICKHOUSE_USER: 'admin-word',
      CLICKHOUSE_PASSWORD: 'pw-word',
      CLICKHOUSE_DATABASE: 'kept',
    });
  });

  it('neither the environment nor a .env names it: a refusal naming CLICKHOUSE_USER, not the `default` user', () => {
    for (const root of [repo(), repo('CLICKHOUSE_DATABASE=analytics\n')]) {
      const r = resolveAdminEnv({}, root);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain('CLICKHOUSE_USER is not set');
        expect(r.message).toContain('default');
      }
    }
  });

  it('a blank CLICKHOUSE_USER counts as unset', () => {
    expect(resolveAdminEnv({ CLICKHOUSE_USER: '  ' }, repo()).ok).toBe(false);
  });
});
