// Algolia REST client over Node's global fetch (no SDK: apps/core/package.json belongs to window 1 and the REST
// surface we need is five endpoints). Errors never carry the API key. Credentials come from env/Vault
// (config.ts), never from code.
import type { IndexClient, IndexSettings, SearchRecord } from './types';

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

  constructor(opts: AlgoliaClientOptions) {
    if (!opts.appId || !opts.apiKey) throw new Error('AlgoliaIndexClient needs appId and apiKey');
    this.appId = opts.appId;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.host = opts.host ?? `https://${opts.appId}.algolia.net`;
    this.waitForTasks = opts.waitForTasks ?? false;
    this.batchSize = opts.batchSize ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.host}${path}`, {
      method,
      headers: {
        'X-Algolia-Application-Id': this.appId,
        'X-Algolia-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // keep the raw (truncated) body
      }
      // never echo the key: the path and Algolia's message are enough
      throw new AlgoliaError(res.status, path, message.replace(this.apiKey, '***'));
    }
    return (text ? JSON.parse(text) : {}) as T;
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
}
