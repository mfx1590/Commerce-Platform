import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Contract tests live apart from the unit suite because they boot Prism, which takes seconds and
 * needs a free port. `pnpm test` stays fast and hermetic; CI runs this in the `contract tests`
 * job alongside `packages/contracts`.
 */

/**
 * The Prism the suite spawns for itself, clear of `pnpm mock` on :4011. Declared here rather than in
 * the test so it can be forced into the environment: a developer with `ADMIN_API_URL` pointed at the
 * real core must still get a run against the contract's own documented examples, since answering the
 * question "does the spec still say what the code reads?" requires the spec, not a live backend.
 */
const CONTRACT_MOCK_URL = 'http://127.0.0.1:4211';

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
    env: {
      ADMIN_SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      // Both names, since ADMIN_API_URL is the one that wins in src/lib/env.ts.
      ADMIN_API_URL: CONTRACT_MOCK_URL,
      MOCK_ADMIN_API_URL: CONTRACT_MOCK_URL,
    },
    include: ['test-contract/**/*.test.ts', 'test-contract/**/*.test.tsx'],
    // Prism takes a few seconds to boot the spec.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
