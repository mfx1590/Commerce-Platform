// Where a published feed file goes (#146, manager decision 2026-09-08: a `FeedStorage` seam with a local
// filesystem default now and an S3-style implementation later — window 5 provisions the bucket).
//
// The key convention is shared with `apps/feeds`, which serves the artifacts: **`<store_code>/<feed_id>.<ext>`**.
// It is the contract between the two processes; both sides validate it, neither ever lists the store.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface PutResult {
  /** The public URL the channel fetches; goes into `product_feed.url`. */
  url: string;
  sha256: string;
}

export interface FeedStorage {
  /** Writes (or overwrites) the artifact and returns its public URL. */
  put(key: string, body: string, contentType: string): Promise<PutResult>;
  /** The hash of what is stored under `key`, or null when nothing is. Drives publish idempotency. */
  head(key: string): Promise<string | null>;
  /** The public URL an artifact would have; used without writing (e.g. reporting an unchanged publish). */
  urlFor(key: string): string;
  /** Removes the artifact; a deleted feed definition stops being served. */
  remove(key: string): Promise<void>;
}

export function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validates a storage key. Two segments, no traversal, no absolute paths — the same check `apps/feeds` runs
 * before it reads, so a crafted `storeCode` or `feedId` can never escape the store root.
 */
export function assertFeedKey(key: string): void {
  const parts = key.split('/');
  const ok =
    parts.length === 2 &&
    parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..' && !p.includes('\\'));
  if (!ok) throw new Error(`invalid feed key: ${key}`);
}

/** `<store_code>/<feed_id>.<ext>` */
export function feedKey(storeCode: string, feedId: string, extension: string): string {
  const key = `${storeCode}/${feedId}.${extension}`;
  assertFeedKey(key);
  return key;
}

export interface FilesystemFeedStorageOptions {
  /** Root directory; `FEEDS_DIR` or `.feeds` at the repo root by default. */
  dir?: string;
  /** Public base URL the channel fetches from; `FEEDS_PUBLIC_URL` by default. */
  baseUrl?: string;
}

/**
 * The default implementation: one file per feed under a directory both this process and `apps/feeds` can read.
 * Good enough for local work and a single-node deployment; the S3 implementation replaces it behind the same
 * interface without touching the publish job.
 */
export class FilesystemFeedStorage implements FeedStorage {
  private readonly dir: string;
  private readonly baseUrl: string;

  constructor(options: FilesystemFeedStorageOptions = {}) {
    this.dir = resolve(options.dir ?? process.env.FEEDS_DIR ?? '.feeds');
    this.baseUrl = (
      options.baseUrl ??
      process.env.FEEDS_PUBLIC_URL ??
      'http://localhost:4020/feeds'
    ).replace(/\/+$/, '');
  }

  private path(key: string): string {
    assertFeedKey(key);
    const full = resolve(join(this.dir, key));
    // Belt and braces: even with a valid-looking key, never write outside the root.
    if (full !== this.dir && !full.startsWith(this.dir + sep)) {
      throw new Error(`invalid feed key: ${key}`);
    }
    return full;
  }

  urlFor(key: string): string {
    assertFeedKey(key);
    return `${this.baseUrl}/${key}`;
  }

  async put(key: string, body: string): Promise<PutResult> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
    return { url: this.urlFor(key), sha256: sha256(body) };
  }

  async head(key: string): Promise<string | null> {
    try {
      return sha256(await readFile(this.path(key), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

let storage: FeedStorage | undefined;

/**
 * Registers the storage implementation at boot — the same seam shape window 1 used for `setTaxCalculator` /
 * `setPaymentProvider`, so swapping in S3 never edits this module.
 */
export function setFeedStorage(next: FeedStorage): void {
  storage = next;
}

export function getFeedStorage(): FeedStorage {
  storage ??= new FilesystemFeedStorage();
  return storage;
}

/** Test helper: forget the registered implementation. */
export function resetFeedStorage(): void {
  storage = undefined;
}
