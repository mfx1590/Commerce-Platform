import { defineConfig } from 'vitest/config';

// Rule, rate-limit, transport, config and DLQ tests need nothing. `ops/consumer.test.ts` builds its own
// throwaway database through @platform/db/testing and applies the PROPOSED migration from ./migrations itself
// (packages/db 0202 is PR #557, not yet on main); its live block also needs the local broker and skips with a
// printed reason when it is down. Loopback is 127.0.0.1 on purpose (Memory-main: Docker's IPv6 proxy dies
// while IPv4 keeps working), and turbo strips DATABASE_URL* from the test environment, so they are set here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://platform:platform@127.0.0.1:5433/platform',
      DATABASE_URL_APP:
        process.env.DATABASE_URL_APP ??
        'postgres://platform_app:platform_app@127.0.0.1:5433/platform',
    },
  },
});
