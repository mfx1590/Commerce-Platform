// The metrics API's read path: one @clickhouse/client per process as the read-only user (`analytics_ro`), created on
// first use from the environment (CLICKHOUSE_URL, CLICKHOUSE_DATABASE, CLICKHOUSE_READONLY_USER /
// CLICKHOUSE_READONLY_PASSWORD, .env.example). It sends NO per-query settings: the user is readonly = 1, and its
// profile (infra/clickhouse/users.d/analytics-readonly.xml) already sets max_execution_time 10 s, max_result_rows
// 100 000 with result_overflow_mode = throw and max_memory_usage 512 MB. A timeout or an overflow is an error the
// executor turns into a 503 — never partial rows. Missing configuration is a 503 too (fail closed), not a crash.
import { createClient } from '@clickhouse/client';
import { AppError } from '../../../lib/errors';
import type { MetricsReader } from './execute';

let shared: MetricsReader | undefined;

export function createMetricsReader(env: NodeJS.ProcessEnv = process.env): MetricsReader {
  const username = env.CLICKHOUSE_READONLY_USER?.trim();
  if (!username)
    throw new AppError('unavailable', 'Analytics store unavailable', { reason: 'not_configured' });
  return createClient({
    url: env.CLICKHOUSE_URL?.trim() || 'http://127.0.0.1:18123',
    username,
    password: env.CLICKHOUSE_READONLY_PASSWORD ?? '',
    database: env.CLICKHOUSE_DATABASE?.trim() || 'analytics',
    request_timeout: 15_000,
  }) as unknown as MetricsReader;
}

/** The process-wide reader, created on the first metrics request. */
export function sharedMetricsReader(): MetricsReader {
  shared ??= createMetricsReader();
  return shared;
}
