// `pnpm --filter @platform/accounting fixtures:payouts` — writes fixtures/payouts/<set>/{events,payouts}.json.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayoutFixtures } from './build.js';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/payouts/', import.meta.url));

export async function writePayoutFixtures(dir = FIXTURES_DIR): Promise<string[]> {
  const written: string[] = [];
  for (const set of buildPayoutFixtures()) {
    const target = path.join(dir, set.name);
    await mkdir(target, { recursive: true });
    const events = path.join(target, 'events.json');
    const payouts = path.join(target, 'payouts.json');
    await writeFile(events, JSON.stringify(set.events, null, 2) + '\n');
    await writeFile(payouts, JSON.stringify(set.files, null, 2) + '\n');
    written.push(events, payouts);
  }
  return written;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  writePayoutFixtures()
    .then((files) => {
      for (const f of files) console.info(`wrote ${f}`);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
