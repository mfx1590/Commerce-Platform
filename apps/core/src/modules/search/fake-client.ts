// In-memory IndexClient with the same semantics as Algolia (upsert by objectID, partial settings merge). Used by
// this module's tests, by the job's `--fake` dry run, and exported for other windows' tests.
import type {
  AlgoliaRule,
  IndexClient,
  IndexSettings,
  SearchParams,
  SearchRecord,
  SearchResponse,
} from './types';

interface FakeIndex {
  records: Map<string, SearchRecord>;
  settings: IndexSettings;
  rules: Map<string, AlgoliaRule>;
}

export interface FakeCall {
  op:
    | 'saveObjects'
    | 'deleteObjects'
    | 'browseObjectIDs'
    | 'getSettings'
    | 'setSettings'
    | 'deleteIndex'
    | 'saveRules'
    | 'clearRules'
    | 'search';
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
      i = { records: new Map(), settings: {}, rules: new Map() };
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

  async saveRules(
    indexName: string,
    rules: AlgoliaRule[],
    opts: { clearExisting?: boolean } = {},
  ): Promise<void> {
    this.calls.push({ op: 'saveRules', indexName, count: rules.length });
    const i = this.index(indexName);
    if (opts.clearExisting) i.rules.clear();
    for (const r of rules) i.rules.set(r.objectID, structuredClone(r));
  }

  async clearRules(indexName: string): Promise<void> {
    this.calls.push({ op: 'clearRules', indexName });
    this.index(indexName).rules.clear();
  }

  /**
   * A small, deterministic stand-in for Algolia's query: substring match on title / handle / brand / tags /
   * sku, `filters` understands `category_id:<id>` (matches `category_id` or any `category_path` ancestor is
   * NOT implied — the real index filters on the attribute, so does this), enabled rules whose condition
   * matches (query pattern `is`, or the same filter) hide buries, promote pins to their positions and rank
   * boosted records first (by weight); the rest is newest-first.
   */
  async search(indexName: string, params: SearchParams): Promise<SearchResponse> {
    this.calls.push({ op: 'search', indexName });
    const i = this.index(indexName);
    const q = params.query.trim().toLowerCase();
    const categoryId = params.filters?.match(/^category_id:(\S+)$/)?.[1];
    let hits = [...i.records.values()].filter((r) => {
      if (categoryId && r.category_id !== categoryId) return false;
      if (!q) return true;
      const hay = [
        r.title,
        r.handle,
        r.brand_name ?? '',
        ...r.tags,
        ...r.variants.map((v) => v.sku),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
    hits.sort(
      (a, b) => b.published_at_ts - a.published_at_ts || a.objectID.localeCompare(b.objectID),
    );

    const now = Math.floor(Date.now() / 1000);
    const active = [...i.rules.values()].filter((r) => {
      if (!r.enabled) return false;
      if (r.validity && !r.validity.some((v) => v.from <= now && now < v.until)) return false;
      return r.conditions.some(
        (c) =>
          (c.pattern !== undefined && c.anchoring === 'is' && c.pattern.toLowerCase() === q) ||
          (c.filters !== undefined && c.filters === params.filters),
      );
    });
    const hidden = new Set<string>();
    const boost = new Map<string, number>();
    const promote: { objectID: string; position: number }[] = [];
    for (const r of active) {
      for (const h of r.consequence.hide ?? []) hidden.add(h.objectID);
      for (const p of r.consequence.promote ?? []) promote.push(p);
      for (const f of r.consequence.params?.optionalFilters ?? []) {
        const m = f.match(/^objectID:(\S+?)<score=(\d+)>$/);
        if (m) boost.set(m[1]!, Number(m[2]));
      }
    }
    hits = hits.filter((h) => !hidden.has(h.objectID));
    if (boost.size > 0)
      hits.sort((a, b) => (boost.get(b.objectID) ?? 0) - (boost.get(a.objectID) ?? 0));
    const promotedIds = new Set(promote.map((p) => p.objectID));
    const rest = hits.filter((h) => !promotedIds.has(h.objectID)).map((h) => h.objectID);
    const ordered: string[] = [];
    let next = 0;
    for (let pos = 0; pos < rest.length + promote.length; pos++) {
      const pinned = promote.find((p) => p.position === pos && i.records.has(p.objectID));
      if (pinned) ordered.push(pinned.objectID);
      else if (next < rest.length) ordered.push(rest[next++]!);
    }
    const page = params.page ?? 0;
    const per = params.hitsPerPage ?? 20;
    return {
      hits: ordered.slice(page * per, page * per + per).map((objectID) => ({ objectID })),
      nbHits: ordered.length,
      page,
      hitsPerPage: per,
    };
  }

  rules(indexName: string): AlgoliaRule[] {
    return [...this.index(indexName).rules.values()].map((r) => structuredClone(r));
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
