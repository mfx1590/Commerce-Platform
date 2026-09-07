#!/usr/bin/env tsx
// Local role management CLI (window 2). Runs as the system actor against the docker stack.
//   pnpm --filter @platform/auth-sdk roles assign <email> <relation> <store-code|hq>
//   pnpm --filter @platform/auth-sdk roles revoke <email> <relation> <store-code|hq>
//   pnpm --filter @platform/auth-sdk roles list   <email>
// Env: DATABASE_URL_APP (platform_app), OPENFGA_API_URL, OPENFGA_STORE_ID, OPENFGA_MODEL_ID (from fga:seed),
//      ORGANIZATION_ID (default: SEED_IDS.organization).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrganizationClient, createPool, SEED_IDS } from '@platform/db';
import {
  assignRole,
  createOpenFgaClient,
  isApiError,
  listRoleAssignments,
  revokeRole,
  type ObjectType,
  type Relation,
} from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

const [cmd, email, relation, target] = process.argv.slice(2);
const usage = () => {
  console.error(
    'usage: roles assign|revoke <email> <relation> <store-code|hq>\n       roles list <email>',
  );
  process.exit(1);
};
if (!cmd || !email) usage();
if ((cmd === 'assign' || cmd === 'revoke') && (!relation || !target)) usage();
if (!['assign', 'revoke', 'list'].includes(cmd!)) usage();

const appUrl = process.env.DATABASE_URL_APP;
if (!appUrl) {
  console.error('DATABASE_URL_APP is required (pnpm dev writes it to .env)');
  process.exit(1);
}
if (!process.env.OPENFGA_STORE_ID) {
  console.error('OPENFGA_STORE_ID is empty: run `pnpm --filter @platform/auth-sdk fga:seed` first');
  process.exit(1);
}

const organizationId = process.env.ORGANIZATION_ID ?? SEED_IDS.organization;
const pool = createPool(appUrl);
const db = createOrganizationClient(pool, { organizationId, actorId: null });
const fga = createOpenFgaClient();

try {
  const user = await db.query<{ id: string }>('SELECT id FROM staff_user WHERE email = $1', [
    email,
  ]);
  if (!user.rowCount) throw new Error(`no staff_user with email ${email}`);
  const staffUserId = user.rows[0]!.id;

  if (cmd === 'list') {
    const items = await listRoleAssignments({ db }, staffUserId);
    for (const a of items) console.info(`${a.id}  ${a.relation}  ${a.object_type}:${a.object_id}`);
    if (items.length === 0) console.info('(no assignments)');
  } else {
    let objectType: ObjectType;
    let objectId: string;
    if (target === 'hq') {
      objectType = 'organization';
      objectId = organizationId;
    } else {
      const store = await db.query<{ id: string }>('SELECT id FROM store WHERE code = $1', [
        target,
      ]);
      if (!store.rowCount) throw new Error(`no store with code ${target}`);
      objectType = 'store';
      objectId = store.rows[0]!.id;
    }
    if (cmd === 'assign') {
      const r = await assignRole(
        { db, fga },
        { staffUserId, relation: relation as Relation, objectType, objectId },
      );
      console.info(
        `${r.created ? 'assigned' : 'already assigned'}: ${email} ${r.assignment.relation} ${objectType}:${objectId} (assignment ${r.assignment.id})`,
      );
    } else {
      const items = await listRoleAssignments({ db }, staffUserId);
      const hit = items.find(
        (a) => a.relation === relation && a.object_type === objectType && a.object_id === objectId,
      );
      if (!hit) throw new Error(`${email} does not hold ${relation} on ${objectType}:${objectId}`);
      await revokeRole({ db, fga }, { staffUserId, assignmentId: hit.id });
      console.info(`revoked: ${email} ${relation} ${objectType}:${objectId}`);
    }
  }
} catch (err) {
  console.error(isApiError(err) ? `${err.code}: ${err.message}` : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
