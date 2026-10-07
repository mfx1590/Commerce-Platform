import { defineConfig } from 'vitest/config';

// Template, transport and server tests need nothing. The consumer tests build their own throwaway database
// through @platform/db/testing (owner URL for fixtures, platform_app for everything the worker does) and apply
// the PROPOSED migration from ./migrations themselves. Loopback is 127.0.0.1 on purpose (Memory-main: Docker's
// IPv6 proxy dies while IPv4 keeps working); CI overrides both URLs.
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
