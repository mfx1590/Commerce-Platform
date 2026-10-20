#!/usr/bin/env node
// Registers every event schema in the schema registry, idempotently (issue #532).
//
//   node infra/redpanda/register-schemas.mjs [--dry-run] [--url http://127.0.0.1:18081]
//   pnpm --filter @platform/events schemas:register [-- --dry-run]
//
// One subject per (topic, version): `<topic>-v<N>-value`, BACKWARD compatibility on each; the registered schema is
// the file with the common $defs inlined (the registry's JSON checker rejects $ref). A second run registers
// nothing (`registered 0`). Needs the events package built (the pnpm script does that). Exit 1 when the registry
// refuses a schema (a published version changed incompatibly) or is unreachable; exit 2 on a usage error.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../packages/events/dist/index.js');
if (!existsSync(dist)) {
  console.error(
    `register-schemas: ${dist} missing — run \`pnpm --filter @platform/events build\` first`,
  );
  process.exit(2);
}
const { createRegistryClient, registerAllSchemas, registryUrlFromEnv } = await import(
  pathToFileURL(dist).href
);

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.info('usage: register-schemas.mjs [--dry-run] [--url http://host:port]');
  process.exit(0);
}
const i = args.indexOf('--url');
const url = i === -1 ? registryUrlFromEnv() : args[i + 1];
const dryRun = args.includes('--dry-run');

const client = createRegistryClient({ url });
if (!(await client.reachable())) {
  console.error(`register-schemas: schema registry at ${url} is unreachable`);
  process.exit(1);
}
const r = await registerAllSchemas(client, { dryRun });
console.info(
  JSON.stringify({
    script: 'register-schemas',
    url,
    dry_run: dryRun,
    schemas: Object.keys(r.ids).length + (dryRun ? r.registered.length : 0),
    registered: r.registered.length,
    unchanged: r.unchanged.length,
    compatibility_set: r.compatibility_set.length,
    refused: r.refused.length,
  }),
);
for (const s of r.registered) console.info(`  registered ${s}`);
for (const s of r.compatibility_set) console.info(`  BACKWARD set on ${s}`);
for (const x of r.refused) console.error(`  REFUSED ${x.subject}: ${x.messages.join('; ')}`);
if (r.refused.length > 0) process.exit(1);
