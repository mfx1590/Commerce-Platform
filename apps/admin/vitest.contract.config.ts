import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Contract tests live apart from the unit suite because they boot Prism, which takes seconds and
 * needs a free port. `pnpm test` stays fast and hermetic; CI runs this in the `contract tests`
 * job alongside `packages/contracts`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    env: { ADMIN_SESSION_SECRET: 'test-session-secret-at-least-32-characters' },
    include: ['test-contract/**/*.test.ts', 'test-contract/**/*.test.tsx'],
    // Prism takes a few seconds to boot the spec.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
