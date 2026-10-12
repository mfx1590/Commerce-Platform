import { tailwindPreset } from '@platform/ui/preset';
import type { Config } from 'tailwindcss';

/**
 * The preset maps every utility onto the `--ui-*` variables that `ThemeProvider` writes, so a brand
 * restyles from API data without touching this file. A brand may add its own utilities here.
 */
const config: Config = {
  presets: [tailwindPreset as Partial<Config>],
  content: [
    './src/**/*.{ts,tsx}',
    // The kit's classes live in its compiled output, so Tailwind must scan it too.
    '../../../packages/ui/dist/**/*.js',
  ],
};

export default config;
