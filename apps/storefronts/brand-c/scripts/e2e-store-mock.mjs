#!/usr/bin/env node
/**
 * A Prism Store mock serving **brand C's** store, so brand C's e2e can run on a laptop (#783).
 *
 *   node scripts/e2e-store-mock.mjs                 # listens on 4018
 *   PORT=4020 node scripts/e2e-store-mock.mjs
 *   # then, in another shell:
 *   MOCK_API_URL=http://127.0.0.1:4018 pnpm --filter @platform/storefront-brand-c e2e csp
 *
 * **Why brand C needs this and A and B do not.** `pnpm mock` serves the Store API contract's own
 * example store, which is brand A's: `en-GB` and `de-DE`. Brand C serves `en-US` only, so every
 * page of it is a correct 404 against that mock, the e2e server never warms up, and the run dies in
 * warm-up with no useful message. That is the gap `CLAUDE.md` describes under "The locale gap".
 *
 * **Nothing here is new.** `scripts/perf.mjs` has done exactly this since #447: it overlays the
 * brand's own `perf/store.example.json` onto a temporary copy of the spec and points Prism at that.
 * This is the same two functions from the same module, exposed as a command so an e2e run can use
 * it too — the example is validated against the spec's `Store` schema first, so a malformed overlay
 * fails here rather than as a puzzling 404 later.
 *
 * It is still a mock: the **products** are the contract's — their names, their amounts, their
 * images. A run that needs brand C's real catalogue points `E2E_STORE_API_URL` at a core instead.
 *
 * **The one thing this does beyond the store: the catalogue's CURRENCY.** The contract's examples
 * are priced in EUR, so a page used to state `Prices in USD` in the footer, from this brand's
 * store, and render `€19.99` in the body, from the contract's products — and brand C's visual
 * baselines were taken with that mismatch in them, which made them blind to a currency-formatting
 * regression (#807). Every `Money.currency` in the spec's examples is rewritten to the store's own
 * currency before the overlay, so the mocked world agrees with itself and the baselines guard the
 * symbol, its placement and the separators. The **amounts** are untouched: 1999 minor units is
 * $19.99 here exactly as it was €19.99 before.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { overlayStoreExample, validateStoreExample } from './perf-store-example.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const contracts = resolve(appRoot, '..', '..', '..', 'packages', 'contracts');
const port = process.env.PORT ?? '4018';

const example = JSON.parse(readFileSync(join(appRoot, 'perf', 'store.example.json'), 'utf8'));
const specText = readFileSync(join(contracts, 'openapi', 'store-api.yaml'), 'utf8');
validateStoreExample(specText, example);

/**
 * Every `currency: XXX` in the spec's **examples** becomes the store's own currency.
 *
 * Safe as a text substitution, and checked rather than assumed: the spec declares
 * `Money.currency` as `{ type: string, pattern: '^[A-Z]{3}$' }` with **no enum**, and every literal
 * currency code in the file sits inside an example — there is no default, no enum member and no
 * parameter value to corrupt. It runs **before** the store overlay, so the brand's own example JSON
 * is written in afterwards and never passes through this.
 *
 * Derived from the store, not hard-coded: if this brand's `perf/store.example.json` ever changes
 * currency, the catalogue follows it without anyone remembering to come back here.
 */
function alignCatalogueCurrency(text, currency) {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(
      `e2e-store-mock: the store example's currency is not a 3-letter code: ${currency}`,
    );
  }
  const before = text.match(/\bcurrency: [A-Z]{3}\b/g)?.length ?? 0;
  if (before === 0) {
    throw new Error(
      'e2e-store-mock: no currency literals found in the spec — has its shape changed?',
    );
  }
  return {
    text: text.replace(/\bcurrency: [A-Z]{3}\b/g, `currency: ${currency}`),
    rewritten: before,
  };
}

const storeCurrency = example.currency ?? example.default_currency;
const aligned = alignCatalogueCurrency(specText, storeCurrency);

const specDir = mkdtempSync(join(tmpdir(), 'brand-c-store-'));
const spec = join(specDir, 'store-api.yaml');
writeFileSync(spec, overlayStoreExample(aligned.text, example));

// The overlaid spec is this process's scratch copy, so it goes when the process does — including
// on Ctrl-C, which is how a mock is usually stopped (#800 review). `exit` runs for all three, and
// the signal handlers are what turn Ctrl-C into an exit at all.
let cleaned = false;
const cleanUp = () => {
  if (cleaned) return;
  cleaned = true;
  rmSync(specDir, { recursive: true, force: true });
};
process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.exit(0);
  });
}

/**
 * Refuse to start quietly behind something that is already on the port.
 *
 * Prism exits with EADDRINUSE and this process follows it, which is correct — but when the script
 * is backgrounded, the exit is easy to miss and the STALE server keeps answering. That is not a
 * harmless confusion here: it is how a set of visual baselines gets re-taken against the old mock,
 * passes, and silently proves nothing (hit while building this very change). Say it on the way in.
 */
async function portIsFree() {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(Number(port), '127.0.0.1');
  });
}

if (!(await portIsFree())) {
  console.error(
    `e2e-store-mock: something is already listening on 127.0.0.1:${port}. ` +
      'It is probably an older copy of this mock, and it will answer every request this one was ' +
      'meant to serve — a run against it proves nothing. Stop it, or pass PORT=<free port> and the ' +
      'same value in MOCK_API_URL.',
  );
  process.exit(1);
}

const require = createRequire(join(contracts, 'package.json'));
const prism = require.resolve('@stoplight/prism-cli/dist/index.js');

console.log(
  `brand C's store (${example.code}, ${example.locales?.join(', ')}) on :${port} — ` +
    `catalogue re-priced in ${storeCurrency} (${aligned.rewritten} example literals)`,
);
const child = spawn(
  process.execPath,
  [prism, 'mock', spec, '--host', '127.0.0.1', '--port', port, '--errors'],
  { stdio: 'inherit' },
);
child.on('exit', (code) => {
  cleanUp();
  process.exit(code ?? 0);
});
