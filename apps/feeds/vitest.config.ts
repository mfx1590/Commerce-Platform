import { defineConfig } from 'vitest/config';

// No database and no docker stack: these tests write artifacts into a temp directory and drive the server over
// loopback. They are deliberately the fastest suite in the repo.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
