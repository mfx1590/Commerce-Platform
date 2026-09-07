// `pnpm --filter @platform/core bootstrap` — verifies that the database is ready to serve the contract
// (issue #8, verifier only). Idempotent, read-only, exit 1 with precise fixes when something is missing.
import path from 'node:path';
import { formatReport, verifyBootstrap } from '../src/bootstrap';
import { closePool, initDb } from '../src/lib/db';

async function main(): Promise<void> {
  await initDb({ startDir: path.resolve(__dirname, '..') });
  const result = await verifyBootstrap();
  console.info(formatReport(result));
  await closePool();
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('bootstrap: failed to run the checks', err);
  process.exit(1);
});
