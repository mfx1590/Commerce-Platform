// In-memory IndexClient with the same semantics as Algolia (upsert by objectID, partial settings merge). Used by
// this module's tests, by the job's `--fake` dry run, and exported for other windows' tests.
import type { IndexClient, IndexSettings, SearchRecord } from './types';

interface FakeIndex {
  records: Map<string, SearchRecord>;
  settings: IndexSettings;
}

export interface FakeCall {
  op:
    | 'saveObjects'
    | 'deleteObjects'
    | 'browseObjectIDs'
    | 'getSettings'
    | 'setSettings'
    | 'deleteIndex';
  indexName: string;
  count?: number;
}

export class FakeIndexClient implements IndexClient {
  private readonly indexes = new Map<string, FakeIndex>();
  /** Every call in order; tests assert batching and idempotency on it. */
  readonly calls: FakeCall[] = [];

  private index(name: string): FakeIndex {
    let i = this.indexes.get(name);
    if (!i) {
      i = { records: new Map(), settings: {} };
      this.indexes.set(name, i);
    }
    return i;
  }

  async saveObjects(indexName: string, records: SearchRecord[]): Promise<void> {
    this.calls.push({ op: 'saveObjects', indexName, count: records.length });
    const i = this.index(indexName);
    for (const r of records) i.records.set(r.objectID, structuredClone(r));
  }

  async deleteObjects(indexName: string, objectIDs: string[]): Promise<void> {
    this.calls.push({ op: 'deleteObjects', indexName, count: objectIDs.length });
    const i = this.index(indexName);
    for (const id of objectIDs) i.records.delete(id);
  }

  async browseObjectIDs(indexName: string): Promise<string[]> {
    this.calls.push({ op: 'browseObjectIDs', indexName });
    return [...this.index(indexName).records.keys()];
  }

  async getSettings(indexName: string): Promise<IndexSettings> {
    this.calls.push({ op: 'getSettings', indexName });
    return structuredClone(this.index(indexName).settings);
  }

  async setSettings(
    indexName: string,
    settings: IndexSettings,
    opts: { forwardToReplicas?: boolean } = {},
  ): Promise<void> {
    this.calls.push({ op: 'setSettings', indexName });
    const i = this.index(indexName);
    i.settings = { ...i.settings, ...structuredClone(settings) };
    if (opts.forwardToReplicas) {
      const { replicas: _r, ...rest } = settings;
      for (const replica of i.settings.replicas ?? []) {
        const ri = this.index(replica);
        ri.settings = { ...ri.settings, ...structuredClone(rest) };
      }
    }
  }

  async deleteIndex(indexName: string): Promise<void> {
    this.calls.push({ op: 'deleteIndex', indexName });
    this.indexes.delete(indexName);
  }

  // ---- inspection helpers for tests ----

  has(indexName: string): boolean {
    return this.indexes.has(indexName);
  }

  indexNames(): string[] {
    return [...this.indexes.keys()];
  }

  records(indexName: string): SearchRecord[] {
    return [...this.index(indexName).records.values()].map((r) => structuredClone(r));
  }

  record(indexName: string, objectID: string): SearchRecord | undefined {
    const r = this.index(indexName).records.get(objectID);
    return r ? structuredClone(r) : undefined;
  }

  settings(indexName: string): IndexSettings {
    return structuredClone(this.index(indexName).settings);
  }
}
