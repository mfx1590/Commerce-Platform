// Writes schemas/published.lock.json from the current schema files (issue #532):
//   pnpm --filter @platform/events schemas:lock        (builds first, then runs this)
// Refuses when a published version changed incompatibly or disappeared; prints what it accepted.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist/index.js');
if (!existsSync(dist)) {
  console.error('lock-schemas: dist missing — run `pnpm --filter @platform/events build` first');
  process.exit(2);
}
const { buildLock, explainVerdict } = await import(pathToFileURL(dist).href);
const lockPath = resolve(here, '../schemas/published.lock.json');
const previous = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;
try {
  const { lock, verdicts } = buildLock(previous);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  const changed = verdicts.filter((v) => v.state !== 'unchanged');
  console.info(
    `lock-schemas: ${Object.keys(lock.schemas).length} published schema(s); ${changed.length} change(s)`,
  );
  for (const v of changed) console.info(`  ${explainVerdict(v).split(' — ')[0]}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
