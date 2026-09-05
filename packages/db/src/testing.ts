// Test helpers (exported as @platform/db/testing). Needs a reachable Postgres via DATABASE_URL (owner role).
import pg from 'pg';
import { migrate } from './migrate.js';

const { Pool } = pg;

export interface TestDatabase {
  /** owner role pool (migrations, fixtures) */
  owner: pg.Pool;
  /** platform_app role pool — subject to RLS. What the application uses. */
  app: pg.Pool;
  name: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * Creates a fresh database `<prefix>_<random>`, migrates it, and returns owner + app pools.
 * The app pool reuses DATABASE_URL_APP credentials (default platform_app/platform_app from .env.example).
 */
export async function createTestDatabase(prefix = 'platform_test'): Promise<TestDatabase> {
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('DATABASE_URL is required for db tests (docker: pnpm compose:up)');
  const appUrl =
    process.env.DATABASE_URL_APP ?? ownerUrl.replace(/\/\/[^@]+@/, '//platform_app:platform_app@');
  const name = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

  const admin = new Pool({ connectionString: ownerUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const owner = new Pool({ connectionString: withDatabase(ownerUrl, name), max: 4 });
  try {
    await migrate(owner);
  } catch (err) {
    await owner.end();
    const a = new Pool({ connectionString: ownerUrl, max: 1 });
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
    throw err;
  }
  const app = new Pool({ connectionString: withDatabase(appUrl, name), max: 4 });
  // DROP DATABASE ... WITH (FORCE) terminates sockets that pool.end() has not fully closed yet; without a
  // listener that FATAL 57P01 surfaces as an unhandled error and fails the run (seen once in CI).
  owner.on('error', () => {});
  app.on('error', () => {});

  return {
    owner,
    app,
    name,
    async drop() {
      await app.end();
      await owner.end();
      const a = new Pool({ connectionString: ownerUrl, max: 1 });
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
