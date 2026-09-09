import localFont from 'next/font/local';

/**
 * The three faces from docs/admin-design.md, committed as woff2 under `public/fonts` and loaded
 * with `next/font/local` rather than `next/font/google` — a build must never need the network, so
 * CI and the image build stay hermetic. Latin subsets only; Cinzel and IBM Plex Sans are single
 * variable files (Google serves the same bytes for every weight), IBM Plex Mono is two statics.
 * Licences: `public/fonts/OFL-*.txt` (SIL Open Font License 1.1).
 *
 * Each exposes a CSS variable that `globals.css` folds into the theme's font tokens, so no
 * component ever names a font family.
 */

export const displayFont = localFont({
  src: [{ path: '../../public/fonts/cinzel-latin.woff2', weight: '500 600', style: 'normal' }],
  variable: '--font-cinzel',
  display: 'swap',
  fallback: ['Times New Roman', 'serif'],
  adjustFontFallback: false,
});

export const bodyFont = localFont({
  src: [
    { path: '../../public/fonts/ibm-plex-sans-latin.woff2', weight: '400 600', style: 'normal' },
  ],
  variable: '--font-plex-sans',
  display: 'swap',
  fallback: ['Segoe UI', 'system-ui', 'sans-serif'],
});

export const monoFont = localFont({
  src: [
    { path: '../../public/fonts/ibm-plex-mono-400-latin.woff2', weight: '400', style: 'normal' },
    { path: '../../public/fonts/ibm-plex-mono-500-latin.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-plex-mono',
  display: 'swap',
  fallback: ['Consolas', 'monospace'],
  preload: false,
});

/** Put on `<html>` so every token below it resolves. */
export const fontClassNames = `${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`;
