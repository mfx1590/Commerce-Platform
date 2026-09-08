#!/usr/bin/env node
// Pushes the fixture documents into a brand dataset through Sanity's HTTP API.
//
//   pnpm --filter @platform/cms seed -- --dataset brand-a     (default: brand-a; `all` for every brand)
//
// Credentials come from the root .env only (SANITY_PROJECT_ID, SANITY_WRITE_TOKEN). Without them
// the script prints the manual steps and exits 0 without writing anything. The token is never logged.
import { loadRootEnv } from './env.mjs';
import {
  PLACEHOLDER_PNG_BASE64,
  assetUploadUrl,
  buildMutations,
  fixtureDocuments,
  manualSteps,
  missingCredentials,
  mutateUrl,
  readSeedEnv,
  resolveDatasets,
} from '../dist/index.js';

loadRootEnv();

const args = process.argv.slice(2);
const datasetArg = args.includes('--dataset') ? args[args.indexOf('--dataset') + 1] : undefined;
const datasets = resolveDatasets(datasetArg);
const env = readSeedEnv(process.env);
const missing = missingCredentials(env);

if (missing.length > 0) {
  console.info(manualSteps(datasets[0], missing));
  process.exit(0);
}

const headers = { Authorization: `Bearer ${env.token}` };

async function call(url, init) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${init.method} ${url.replace(env.projectId, '<project>')} → ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

for (const dataset of datasets) {
  const asset = await call(assetUploadUrl(env.projectId, env.apiVersion, dataset), {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from(PLACEHOLDER_PNG_BASE64, 'base64'),
  });
  const mutations = buildMutations(fixtureDocuments, asset.document._id);
  const result = await call(mutateUrl(env.projectId, env.apiVersion, dataset), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutations }),
  });
  console.info(
    `${dataset}: ${(result.results ?? []).length} documents written (${(result.results ?? []).map((r) => r.id).join(', ')})`,
  );
}
