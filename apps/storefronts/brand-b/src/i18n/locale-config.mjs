/**
 * The app's locales, from the environment — **the one definition** (#441 part 4).
 *
 * Plain JavaScript on purpose: `src/i18n/routing.ts` (the app), `scripts/e2e-server.mjs` (plain
 * Node, no TypeScript) and the e2e specs all import it, so the URL prefix the server warms, the
 * locale the specs navigate to and the locales the app routes can never disagree. A brand sets
 * `SUPPORTED_LOCALES` (and optionally `DEFAULT_LOCALE`) in its own `next.config.mjs`; the defaults are
 * the starter's and brand A's (`en-GB`, `de-DE`).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ locales: string[], defaultLocale: string }}
 */
export function localeConfigFromEnv(env) {
  const raw = env.SUPPORTED_LOCALES;
  const locales =
    raw === undefined || raw.trim() === ''
      ? ['en-GB', 'de-DE']
      : raw
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value !== '');
  const defaultLocale = env.DEFAULT_LOCALE ?? locales[0] ?? 'en-GB';
  return { locales, defaultLocale };
}
