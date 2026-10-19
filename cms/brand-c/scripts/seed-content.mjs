#!/usr/bin/env node
/**
 * Push brand A's real content into the `brand-c` Sanity dataset.
 *
 *   node cms/brand-c/scripts/seed-content.mjs --dry-run   # validate + print, writes nothing
 *   node cms/brand-c/scripts/seed-content.mjs --yes       # actually write to the dataset
 *
 * **Why this is not `@platform/cms`'s own seed script.** That one pushes window 6's generic
 * fixtures — one document per type, deliberately minimal, shared by every brand as a smoke test.
 * This pushes brand A's actual published content, which is brand-owned (`cms/<brand>/**` in
 * docs/ownership.md) and lives here.
 *
 * It reuses window 6's *pure* exported helpers rather than reimplementing them — `readSeedEnv`,
 * `missingCredentials`, `mutateUrl` — so the credential handling and the URL shape stay in one
 * place and this file owns only what is brand-specific: which documents to send.
 *
 * Documents carry deterministic ids (`<type>.<locale>.<slug>`), so `createOrReplace` is idempotent:
 * re-running updates in place rather than duplicating. That is also what makes a re-seed safe after
 * editing the JSON.
 *
 * Needs `SANITY_PROJECT_ID` and `SANITY_WRITE_TOKEN` in the root `.env`. Without them it prints
 * what it would do and exits 0, so `--dry-run` is also the no-credentials path — a developer can
 * always check the payload without being able to write to the dataset.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  missingCredentials,
  mutateUrl,
  readSeedEnv,
  validateDocument,
  schemaTypes,
} from '@platform/cms';
import { cloudNameFrom, resolveMedia } from './resolve-media.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.resolve(here, '..', 'content');
const DATASET = 'brand-c';

const dryRun = process.argv.includes('--dry-run');

/**
 * Writing requires `--yes`.
 *
 * `createOrReplace` is idempotent with respect to *these files*, which is not the same as safe: it
 * replaces whatever is in the dataset, so an editor's work in the Studio is overwritten without a
 * word. Re-running this after someone has edited a page is a plausible accident, and the cost falls
 * on a person who cannot see this script. So the destructive path is opt-in and the default
 * explains itself.
 */
const confirmed = process.argv.includes('--yes');

/** Every document in content/, in a stable order so a dry run diffs cleanly between invocations. */
function readContent() {
  return readdirSync(contentDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((file) => JSON.parse(readFileSync(path.join(contentDir, file), 'utf8')));
}

// Images are authored as media slots and become Cloudinary URLs here (resolve-media.mjs). Only the
// cloud name is read — never the Cloudinary API key or secret.
const manifest = JSON.parse(
  readFileSync(path.resolve(here, '..', 'media', 'manifest.json'), 'utf8'),
);
let cloudName;
try {
  cloudName = cloudNameFrom(process.env);
} catch (error) {
  console.error(`media: ${error.message}; nothing was sent.`);
  process.exit(1);
}
const media = resolveMedia(readContent(), manifest, cloudName === undefined ? {} : { cloudName });
if (media.errors.length > 0) {
  for (const error of media.errors) console.error(`media: ${error}`);
  console.error(`\n${media.errors.length} media error(s); nothing was sent.`);
  process.exit(1);
}
if (media.dropped > 0) {
  console.warn(
    `media: no Cloudinary cloud name (CLOUDINARY_CLOUD_NAME_BRAND_B or CLOUDINARY_CLOUD_NAME); ` +
      `${media.dropped} optional image(s) left out.`,
  );
}
const documents = media.documents;

// Validate before sending, never after. A schema violation that reaches the dataset is visible to
// editors in the Studio and has to be fixed by hand there; caught here it is a one-line edit.
let invalid = 0;
for (const doc of documents) {
  const errors = await validateDocument(doc, schemaTypes);
  for (const error of errors) {
    invalid += 1;
    console.error(`invalid ${doc._id}: ${error.path} — ${error.message}`);
  }
}
if (invalid > 0) {
  console.error(`\n${invalid} validation error(s); nothing was sent.`);
  process.exit(1);
}

const byType = documents.reduce((acc, d) => ({ ...acc, [d._type]: (acc[d._type] ?? 0) + 1 }), {});
console.log(
  `brand-c content: ${documents.length} documents valid ` +
    `(${Object.entries(byType)
      .map(([t, n]) => `${n} ${t}`)
      .join(', ')})`,
);

const env = readSeedEnv(process.env);
const missing = missingCredentials(env);

if (dryRun || missing.length > 0) {
  if (missing.length > 0 && !dryRun) {
    console.log(`\nNot sending: ${missing.join(' and ')} not set. Showing the payload instead.`);
  }
  for (const doc of documents) console.log(`  would replace ${doc._id}`);
  process.exit(0);
}

if (!confirmed) {
  console.log(
    [
      '',
      `Refusing to write: this would REPLACE ${documents.length} documents in the "${DATASET}" dataset,`,
      'including any edits made in the Studio since the last seed. That cannot be undone from here.',
      '',
      '  --dry-run   validate and print, writing nothing',
      '  --yes       write to the dataset',
    ].join('\n'),
  );
  process.exit(1);
}

const mutations = documents.map((doc) => ({ createOrReplace: doc }));
const response = await fetch(mutateUrl(env.projectId, env.apiVersion, DATASET), {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${env.token}` },
  body: JSON.stringify({ mutations }),
});

if (!response.ok) {
  console.error(`seed failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const result = await response.json();
console.log(`${(result.results ?? []).length} documents written to ${DATASET}`);
