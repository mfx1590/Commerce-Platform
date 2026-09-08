// Algolia REST client over Node's global fetch (no SDK: apps/core/package.json belongs to window 1 and the REST
// surface we need is five endpoints). Errors never carry the API key. Credentials come from env/Vault
// (config.ts), never from code.
import type {
  AlgoliaRule,
  IndexClient,
  IndexSettings,
  SearchParams,
  SearchRecord,
  SearchResponse,
} from './types';

export interface AlgoliaClientOptions {
  appId: string;
  apiKey: string;
  /** Override for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default `https://<appId>.algolia.net` (write host). Algolia fails over on its own for reads. */
  host?: string;
  /** Poll each indexing task until published (live tests; slower, but the next read sees the write). */
  waitForTasks?: boolean;
  /** Records per batch request (Algolia caps a batch by payload size; 1000 is the SDK default). */
  batchSize?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network failure (default 3; 0 disables). */
  retries?: number;
  /** First backoff delay in ms, doubled per attempt (default 500; tests pass 0). */
  retryBaseMs?: number;
}

export class AlgoliaError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`algolia ${status} on ${path}: ${message}`);
    this.name = 'AlgoliaError';
  }
}

interface TaskResponse {
  taskID?: number;
}

export class AlgoliaIndexClient implements IndexClient {
  private readonly appId: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly host: string;
  private readonly waitForTasks: boolean;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;

  constructor(opts: AlgoliaClientOptions) {
    if (!opts.appId || !opts.apiKey) throw new Error('AlgoliaIndexClient needs appId and apiKey');
    this.appId = opts.appId;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.host = opts.host ?? `https://${opts.appId}.algolia.net`;
    this.waitForTasks = opts.waitForTasks ?? false;
    this.batchSize = opts.batchSize ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = Math.max(0, opts.retries ?? 3);
    this.retryBaseMs = Math.max(0, opts.retryBaseMs ?? 500);
  }

  /** Never echo the key: the path and Algolia's message are enough (every occurrence masked). */
  private redact(message: string): string {
    return message.replaceAll(this.apiKey, '***');
  }

  /**
   * One HTTP call with retries: 429 and 5xx (and a network / timeout failure) are retried `retries` times with
   * exponential backoff (`retryBaseMs` × 2^attempt) so a transient Algolia error does not fail a store's run.
   * 4xx other than 429 is final.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.host}${path}`, {
          method,
          headers: {
            'X-Algolia-Application-Id': this.appId,
            'X-Algolia-API-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt >= this.retries)
          throw new AlgoliaError(
            0,
            path,
            this.redact(err instanceof Error ? err.message : String(err)),
          );
        await this.backoff(attempt);
        continue;
      }
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // keep the raw (truncated) body
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.retries)
        throw new AlgoliaError(res.status, path, this.redact(message));
      await this.backoff(attempt);
    }
  }

  private async backoff(attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.retryBaseMs * 2 ** attempt));
  }

  private async waitTask(indexName: string, r: TaskResponse): Promise<void> {
    if (!this.waitForTasks || r.taskID === undefined) return;
    const path = `/1/indexes/${encodeURIComponent(indexName)}/task/${r.taskID}`;
    for (let i = 0; i < 100; i++) {
      const t = await this.request<{ status: string }>('GET', path);
      if (t.status === 'published') return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * (i + 1))));
    }
    throw new AlgoliaError(504, path, 'task not published in time');
  }

  async saveObjects(indexName: string, records: SearchRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += this.batchSize) {
      const chunk = records.slice(i, i + this.batchSize);
      const r = await this.request<TaskResponse>(
        'POST',
        `/1/indexes/${encodeURIComponent(indexName)}/batch`,
        { requests: chunk.map((body) => ({ action: 'updateObject', body })) },
      );
      await this.waitTask(indexName, r);
    }
  }

  async deleteObjects(indexName: string, objectIDs: string[]): Promise<void> {
    for (let i = 0; i < objectIDs.length; i += this.batchSize) {
      const chunk = objectIDs.slice(i, i + this.batchSize);
      const r = await this.request<TaskResponse>(
        'POST',
        `/1/indexes/${encodeURIComponent(indexName)}/batch`,
        { requests: chunk.map((objectID) => ({ action: 'deleteObject', body: { objectID } })) },
      );
      await this.waitTask(indexName, r);
    }
  }

  async browseObjectIDs(indexName: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<{ hits: { objectID: string }[]; cursor?: string }>(
        'POST',
        `/1/indexes/${encodeURIComponent(indexName)}/browse`,
        { attributesToRetrieve: [], hitsPerPage: 1000, ...(cursor ? { cursor } : {}) },
      );
      for (const h of page.hits) ids.push(h.objectID);
      cursor = page.cursor;
    } while (cursor);
    return ids;
  }

  async getSettings(indexName: string): Promise<IndexSettings> {
    try {
      return await this.request<IndexSettings>(
        'GET',
        `/1/indexes/${encodeURIComponent(indexName)}/settings`,
      );
    } catch (err) {
      // An index that has never been written does not exist yet: same as empty settings.
      if (err instanceof AlgoliaError && err.status === 404) return {};
      throw err;
    }
  }

  async setSettings(
    indexName: string,
    settings: IndexSettings,
    opts: { forwardToReplicas?: boolean } = {},
  ): Promise<void> {
    const qs = opts.forwardToReplicas ? '?forwardToReplicas=true' : '';
    const r = await this.request<TaskResponse>(
      'PUT',
      `/1/indexes/${encodeURIComponent(indexName)}/settings${qs}`,
      settings,
    );
    await this.waitTask(indexName, r);
  }

  async deleteIndex(indexName: string): Promise<void> {
    const r = await this.request<TaskResponse>(
      'DELETE',
      `/1/indexes/${encodeURIComponent(indexName)}`,
    );
    await this.waitTask(indexName, r);
  }

  async saveRules(
    indexName: string,
    rules: AlgoliaRule[],
    opts: { clearExisting?: boolean } = {},
  ): Promise<void> {
    const qs = opts.clearExisting ? '?clearExistingRules=true' : '';
    const r = await this.request<TaskResponse>(
      'POST',
      `/1/indexes/${encodeURIComponent(indexName)}/rules/batch${qs}`,
      rules,
    );
    await this.waitTask(indexName, r);
  }

  async clearRules(indexName: string): Promise<void> {
    const r = await this.request<TaskResponse>(
      'POST',
      `/1/indexes/${encodeURIComponent(indexName)}/rules/clear`,
    );
    await this.waitTask(indexName, r);
  }

  async search(indexName: string, params: SearchParams): Promise<SearchResponse> {
    const res = await this.request<Partial<SearchResponse>>(
      'POST',
      `/1/indexes/${encodeURIComponent(indexName)}/query`,
      { ...params, attributesToRetrieve: ['objectID'] },
    );
    return {
      hits: (res.hits ?? []).map((h) => ({ objectID: h.objectID })),
      nbHits: res.nbHits ?? 0,
      page: res.page ?? params.page ?? 0,
      hitsPerPage: res.hitsPerPage ?? params.hitsPerPage ?? 20,
    };
  }
}
