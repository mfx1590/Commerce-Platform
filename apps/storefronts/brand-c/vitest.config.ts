import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app tsconfig sets `jsx: preserve` because Next compiles JSX itself, so esbuild would fall
  // back to the classic transform and reference an undefined `React` when a test imports a
  // component directly.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A brand's locales (#440, #441 part 5): routing reads SUPPORTED_LOCALES / DEFAULT_LOCALE, and a
    // brand declares them in its next.config.mjs — which vitest never loads. Passed through from the
    // environment, so a brand's unit suite tests that brand (set them in its test script or CI);
    // unset, the starter's defaults apply exactly as before. DEFAULT_LOCALE only when set, so a
    // brand's list is never paired with the starter's default.
    env: {
      SUPPORTED_LOCALES: process.env.SUPPORTED_LOCALES ?? 'en-GB,de-DE',
      ...(process.env.DEFAULT_LOCALE ? { DEFAULT_LOCALE: process.env.DEFAULT_LOCALE } : {}),
    },
    server: {
      deps: {
        // next-intl is an isolated pnpm package, so its own `next/navigation` import does not
        // resolve from inside node_modules. Inlining makes Vite resolve it from this app instead.
        inline: ['next-intl'],
      },
    },
  },
});
