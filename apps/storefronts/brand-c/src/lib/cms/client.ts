/**
 * A typed GROQ client over Sanity's HTTP query API — a plain `fetch` wrapper, no `@sanity/client`.
 *
 * Same reasoning as `src/lib/store-api`: one module knows the URLs, the token and the header
 * names; everything above receives typed documents. It keeps the storefront free of another
 * dependency, lets tests inject `fetchImpl`, and keeps Next's data cache in charge of caching
 * (`next: { tags, revalidate }`) instead of a second cache inside a client library.
 *
 * Two perspectives:
 * - **published** — the CDN host (`apicdn.sanity.io`), no token, cached with tags, so a publish
 *   webhook can drop exactly the pages that changed.
 * - **preview** (drafts) — the live API host, the read token, `cache: 'no-store'`.
 */

export interface CmsClientConfig {
  projectId: string;
  dataset: string;
  apiVersion: string;
  /** Required for preview; ignored for published reads (the CDN serves public content). */
  readToken?: string | null | undefined;
  preview?: boolean | undefined;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
}

export type GroqParams = Record<string, string | number | boolean | null>;

export interface QueryOptions {
  tags?: string[] | undefined;
  revalidate?: number | false | undefined;
}

/** A GROQ string with the result type attached, so `client.fetch(query, …)` is typed. */
export interface GroqQuery<TResult> {
  groq: string;
  /** phantom — never set at runtime */
  readonly __result?: TResult;
}

export function defineQuery<TResult>(groq: string): GroqQuery<TResult> {
  return { groq };
}

/** Next's fetch extensions, declared locally so this stays a plain `fetch` wrapper. */
interface NextFetchOptions {
  tags?: string[];
  revalidate?: number | false;
}

export class CmsError extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'CmsError';
  }
}

export function queryUrl(
  config: Pick<CmsClientConfig, 'projectId' | 'dataset' | 'apiVersion' | 'preview'>,
  groq: string,
  params: GroqParams = {},
): string {
  const host = config.preview ? 'api.sanity.io' : 'apicdn.sanity.io';
  const url = new URL(
    `https://${config.projectId}.${host}/v${config.apiVersion}/data/query/${config.dataset}`,
  );
  url.searchParams.set('query', groq);
  // GROQ parameters travel as `$name=<json>`; never interpolated into the query string itself.
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(`$${name}`, JSON.stringify(value));
  }
  url.searchParams.set('perspective', config.preview ? 'drafts' : 'published');
  return url.toString();
}

export class CmsClient {
  readonly preview: boolean;
  readonly dataset: string;
  readonly #config: CmsClientConfig;
  readonly #fetch: typeof fetch;

  constructor(config: CmsClientConfig) {
    if (config.preview && !config.readToken) {
      throw new Error('CMS preview needs SANITY_READ_TOKEN: drafts are never public');
    }
    this.#config = config;
    this.preview = config.preview === true;
    this.dataset = config.dataset;
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
  }

  async fetch<T>(
    query: GroqQuery<T>,
    params: GroqParams = {},
    options: QueryOptions = {},
  ): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    const init: RequestInit & { next?: NextFetchOptions } = { method: 'GET', headers };

    if (this.preview) {
      headers.set('authorization', `Bearer ${this.#config.readToken}`);
      init.cache = 'no-store';
    } else {
      const next: NextFetchOptions = {};
      if (options.tags) next.tags = options.tags;
      if (options.revalidate !== undefined) next.revalidate = options.revalidate;
      if (Object.keys(next).length > 0) init.next = next;
    }

    const response = await this.#fetch(queryUrl(this.#config, query.groq, params), init);
    const requestId = response.headers.get('x-sanity-request-id');
    if (!response.ok) {
      throw new CmsError(response.status, requestId, `Sanity query failed (${response.status})`);
    }
    let body: { result?: T };
    try {
      body = (await response.json()) as { result?: T };
    } catch {
      throw new CmsError(response.status, requestId, 'Sanity returned invalid JSON');
    }
    return (body.result ?? null) as T;
  }
}
