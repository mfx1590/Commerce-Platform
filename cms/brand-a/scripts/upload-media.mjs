#!/usr/bin/env node
/**
 * Upload brand A's media to Cloudinary — **run by the owner**, never by CI or a build.
 *
 *   node cms/brand-a/scripts/upload-media.mjs --from <media dir>          # plan: verify, print, send nothing
 *   node cms/brand-a/scripts/upload-media.mjs --from <media dir> --yes    # upload
 *
 * `<media dir>` is the folder the owner's generator wrote (`commerce-platform-media/brand-a`, outside
 * the repo); the paths inside it are `media/manifest.json`'s `source` fields. Every file is checked
 * against the manifest's sha256 **before** anything is sent, so a re-rendered or swapped file is
 * caught instead of published under the old slot.
 *
 * Credentials: `CLOUDINARY_*_BRAND_A`, else `CLOUDINARY_*` (the per-store override convention in
 * `.env.example`). The key and secret are used to sign the request and are never printed. Without
 * them the plan is printed and the script exits 0 — which is also how it behaves today, with no
 * Cloudinary account yet.
 *
 * Uploads use the slot's `publicId` with `overwrite=false`: re-running is safe, and replacing an
 * image is a deliberate act (delete it in Cloudinary first), never a side effect.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.resolve(here, '..', 'media', 'manifest.json'), 'utf8'),
);

const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');
const from = fromIndex === -1 ? undefined : args[fromIndex + 1];
const confirmed = args.includes('--yes');

if (from === undefined) {
  console.error('usage: upload-media.mjs --from <media dir> [--yes]');
  process.exit(1);
}

const pick = (name) => process.env[`${name}_BRAND_A`] || process.env[name] || undefined;
const cloudName = pick('CLOUDINARY_CLOUD_NAME');
const apiKey = pick('CLOUDINARY_API_KEY');
const apiSecret = pick('CLOUDINARY_API_SECRET');

// 1. Verify every file before sending any.
let bad = 0;
for (const slot of manifest.slots) {
  const file = path.join(from, slot.source);
  if (!existsSync(file)) {
    console.error(`missing  ${slot.slot}: ${slot.source}`);
    bad += 1;
    continue;
  }
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (sha256 !== slot.sha256) {
    console.error(`changed  ${slot.slot}: ${slot.source} does not match the manifest's sha256`);
    bad += 1;
  }
}
if (bad > 0) {
  console.error(`\n${bad} file(s) missing or changed; nothing was sent.`);
  process.exit(1);
}
console.log(`${manifest.slots.length} files verified against media/manifest.json`);

// Cloudinary's free plan refuses images over 10 MB (videos: 100 MB). The 4K stills are 9.8–15.7 MiB,
// so most fail one by one on that plan; say so up front rather than half-way through a run.
const IMAGE_LIMIT = 10 * 1024 * 1024;
const oversize = manifest.slots.filter((s) => s.kind === 'image' && s.bytes > IMAGE_LIMIT);
if (oversize.length > 0) {
  console.warn(
    `note: ${oversize.length} image(s) exceed 10 MB — Cloudinary's free-plan upload limit. ` +
      'A paid plan takes them as they are.',
  );
}

const missing = [
  ['cloud name', cloudName],
  ['API key', apiKey],
  ['API secret', apiSecret],
]
  .filter(([, value]) => !value)
  .map(([label]) => label);

if (missing.length > 0 || !confirmed) {
  if (missing.length > 0) console.log(`Not uploading: no Cloudinary ${missing.join(', ')}.`);
  for (const slot of manifest.slots)
    console.log(`  would upload ${slot.source} -> ${slot.publicId}`);
  if (missing.length === 0) console.log('\nRe-run with --yes to upload.');
  process.exit(0);
}

// 2. Upload, signed. https://cloudinary.com/documentation/upload_images#generating_authentication_signatures
for (const slot of manifest.slots) {
  const resource = slot.kind === 'video' ? 'video' : 'image';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = { overwrite: 'false', public_id: slot.publicId, timestamp };
  const toSign = Object.entries(signed)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = createHash('sha1')
    .update(toSign + apiSecret)
    .digest('hex');

  const form = new globalThis.FormData();
  form.append(
    'file',
    new globalThis.Blob([readFileSync(path.join(from, slot.source))]),
    path.basename(slot.source),
  );
  for (const [k, v] of Object.entries(signed)) form.append(k, v);
  form.append('api_key', apiKey);
  form.append('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resource}/upload`, {
    method: 'POST',
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`failed   ${slot.publicId}: ${response.status} ${body?.error?.message ?? ''}`);
    process.exit(1);
  }
  console.log(`${body.existing ? 'exists  ' : 'uploaded'} ${slot.publicId}`);
}
