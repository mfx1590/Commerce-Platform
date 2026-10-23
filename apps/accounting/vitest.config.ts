import { defineConfig } from 'vitest/config';

// The posting tests are pure. The ledger tests build their own throwaway database through @platform/db/testing
// (owner URL for the migrations and fixtures, platform_app for everything the service does). The broker tests use the local Redpanda on
// prefixed topics and skip with a printed reason when it is down. Loopback is 127.0.0.1 on purpose (Memory-main:
// Docker's IPv6 proxy dies while IPv4 keeps working); CI overrides the URLs.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://platform:platform@127.0.0.1:5433/platform',
      DATABASE_URL_APP:
        process.env.DATABASE_URL_APP ??
        'postgres://platform_app:platform_app@127.0.0.1:5433/platform',
      KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? '127.0.0.1:19092',
    },
  },
});
