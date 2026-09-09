// Read side of the feed artifact store.
//
// The write side lives in the core's marketing module (`apps/core/src/modules/marketing/storage.ts`): the
// publish job renders the file and stores it, this app only serves what is there. The two processes share a
// **key convention, not code** — a core module cannot import from an app and vice versa:
//
//     <store_code>/<feed_id>.<ext>        e.g. brand-a/70000000-…-0731.xml
//
// Both sides validate the key the same way. Changing the convention means changing both, and it is documented
// in both READMEs for exactly that reason.
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const STORE_CODE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FEED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSIONS = new Set(['xml', 'csv']);

export const CONTENT_TYPE: Record<string, string> = {
  xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

export interface FeedRef {
  storeCode: string;
  feedId: string;
  extension: string;
}

/**
 * Parses `/feeds/<store_code>/<feed_id>.<ext>`. Everything is checked against a pattern rather than sanitised:
 * a `store_code` of `..` or a `feed_id` carrying a slash is not cleaned up, it is refused. There is no path
 * here that a crafted URL can walk out of, and no shape of request that lists a directory.
 */
export function parseFeedPath(pathname: string): FeedRef | null {
  const parts = pathname.split('/').filter((p) => p !== '');
  if (parts.length !== 3 || parts[0] !== 'feeds') return null;
  const [, storeCode, file] = parts as [string, string, string];
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  const feedId = file.slice(0, dot);
  const extension = file.slice(dot + 1).toLowerCase();
  if (!STORE_CODE.test(storeCode)) return null;
  if (!FEED_ID.test(feedId)) return null;
  if (!EXTENSIONS.has(extension)) return null;
  return { storeCode, feedId, extension };
}

export interface FeedReaderOptions {
  /** Artifact root; the same directory the core's `FilesystemFeedStorage` writes into. */
  dir: string;
  /**
   * The store codes this instance serves. Empty means "any code found under the root", which is only allowed
   * outside production — see `resolveConfig`.
   */
  storeCodes?: readonly string[];
}

export class FeedReader {
  private readonly dir: string;
  private readonly allowed: ReadonlySet<string> | null;

  constructor(options: FeedReaderOptions) {
    this.dir = resolve(options.dir);
    this.allowed =
      options.storeCodes && options.storeCodes.length > 0 ? new Set(options.storeCodes) : null;
  }

  serves(storeCode: string): boolean {
    return this.allowed === null || this.allowed.has(storeCode);
  }

  /** The artifact bytes, or null when there is nothing to serve. Never throws for a missing file. */
  async read(ref: FeedRef): Promise<string | null> {
    if (!this.serves(ref.storeCode)) return null;
    const full = resolve(join(this.dir, ref.storeCode, `${ref.feedId}.${ref.extension}`));
    // Belt and braces on top of the pattern checks: never read outside the root.
    if (!full.startsWith(this.dir + sep)) return null;
    try {
      return await readFile(full, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
