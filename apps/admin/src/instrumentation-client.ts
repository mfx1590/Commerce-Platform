/**
 * Runs in the browser before any of the app's own modules (Next's client instrumentation hook).
 *
 * zod 4 compiles a fast path for object schemas with `new Function`, and decides whether it may by
 * calling `Function("")` once, in a try/catch, when the first object schema is constructed — which
 * here is at module load (the form schemas). Under the CSP (no 'unsafe-eval', src/lib/security/csp.ts)
 * that probe is refused: nothing breaks, zod falls back, but the browser reports a CSP violation on
 * every page that loads a schema, and violations are what the e2e watches for (e2e/csp.spec.ts).
 *
 * `jitless` skips the probe and the compile, and it has to be set before the first schema exists,
 * hence here and not in a component. It is preset on the global zod's `config()` adopts rather than
 * by importing `config` from 'zod/v4/core': that import put ~3.5 kB on every page's first load.
 * test/zod-jitless.test.ts proves zod still reads this global, so an upgrade that moves it fails there.
 */
export {};

const zodGlobal = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
zodGlobal.__zod_globalConfig = { ...zodGlobal.__zod_globalConfig, jitless: true };
