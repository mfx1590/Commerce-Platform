import { defineConfig } from 'vitest/config';

// Unit tests need nothing. `src/live.test.ts` is opt-in (ANALYTICS_LIVE=1, or CI) and needs ClickHouse (CLICKHOUSE_URL/USER/PASSWORD, default 127.0.0.1:18123) and the
// broker (KAFKA_BROKERS, default 127.0.0.1:19092) and skips with a printed reason when either is down.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
