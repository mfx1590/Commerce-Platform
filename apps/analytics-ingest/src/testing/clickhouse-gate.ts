// The gate for ClickHouse-backed tests: opt-in on a laptop (ANALYTICS_LIVE=1, only while holding the machine; CI
// always), then the configured user must authenticate. Returns null to run, or the reason to skip (printed).
import type { ClickHouseConfig } from '../config.js';

export async function clickHouseSkipReason(cfg: ClickHouseConfig): Promise<string | null> {
  const optedIn = process.env.ANALYTICS_LIVE === '1' || process.env.CI === 'true';
  if (!optedIn) return 'not opted in (set ANALYTICS_LIVE=1 once you hold the machine)';
  try {
    const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    const res = await fetch(`${cfg.url}/?query=SELECT%201`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok ? null : `${cfg.url}: HTTP ${res.status} for user ${cfg.username}`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return `${cfg.url}: ${cause ?? (err as Error).name}`;
  }
}

/** A throwaway database name for DDL tests (never `analytics`). */
export const throwawayDatabase = (): string =>
  `analytics_test_${Math.random().toString(36).slice(2, 8)}`;
