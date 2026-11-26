import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
    // ADMIN_SESSION_SECRET is mandatory in every environment (src/lib/env.ts); the route and
    // middleware tests exercise code that reads it.
    env: { ADMIN_SESSION_SECRET: 'test-session-secret-at-least-32-characters' },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // 15 s, not vitest's 5 s default. On a loaded laptop (a stack booting, other windows' suites running),
    // user-event screen tests miss 5 s across unrelated files. The same run passes with --maxWorkers=2, so the
    // failures were load, not bugs. A test that is genuinely stuck still fails, just later.
    testTimeout: 15_000,
  },
});
