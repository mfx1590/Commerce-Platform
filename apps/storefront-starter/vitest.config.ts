import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      deps: {
        // next-intl is an isolated pnpm package, so its own `next/navigation` import does not
        // resolve from inside node_modules. Inlining makes Vite resolve it from this app instead.
        inline: ['next-intl'],
      },
    },
  },
});
