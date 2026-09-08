// Storage of merchandising rules. `PgRulesRepository` targets the proposed `merchandising_rule` table
// (proposed/0130_merchandising_rule.sql; tests apply it to their throwaway database until the migration lands);
// `MemoryRulesRepository` is the local mock for environments without the table (job dry runs, other windows'
// tests). Both enforce one rule per (store, scope).
import type { Queryable } from '@platform/db';
import { conflict, mapPgError } from '../../lib/errors';
import type {
  MerchandisingRule,
  MerchandisingRulePatch,
  MerchandisingScope,
} from './merchandising-types';

export interface NewRule {
  organizationId: string;
  storeId: string;
  scope: MerchandisingScope;
  pins: string[];
  boosts: MerchandisingRule['boosts'];
  buries: string[];
  enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export interface RulesRepository {
  list(tx: Queryable, storeId: string): Promise<MerchandisingRule[]>;
  get(tx: Queryable, storeId: string, id: string): Promise<MerchandisingRule | null>;
  create(tx: Queryable, rule: NewRule): Promise<MerchandisingRule>;
  /** Returns null when the rule does not exist in the store. */
  update(
    tx: Queryable,
    storeId: string,
    id: string,
    patch: MerchandisingRulePatch,
  ): Promise<MerchandisingRule | null>;
  delete(tx: Queryable, storeId: string, id: string): Promise<boolean>;
  markPublished(tx: Queryable, storeId: string, ids: string[], at: Date): Promise<void>;
}

export function scopeKey(scope: MerchandisingScope): string {
  return scope.type === 'category' ? scope.category_id : scope.query;
}

// ---------------------------------------------------------------------------------------------------- memory

export class MemoryRulesRepository implements RulesRepository {
  private readonly rows = new Map<string, MerchandisingRule>();
  private seq = 0;

  private nextId(): string {
    this.seq += 1;
    return `40000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }

  async list(_tx: Queryable, storeId: string): Promise<MerchandisingRule[]> {
    return [...this.rows.values()]
      .filter((r) => r.store_id === storeId)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .map((r) => structuredClone(r));
  }

  async get(_tx: Queryable, storeId: string, id: string): Promise<MerchandisingRule | null> {
    const r = this.rows.get(id);
    return r && r.store_id === storeId ? structuredClone(r) : null;
  }

  async create(_tx: Queryable, rule: NewRule): Promise<MerchandisingRule> {
    const key = scopeKey(rule.scope);
    for (const r of this.rows.values()) {
      if (
        r.store_id === rule.storeId &&
        r.scope.type === rule.scope.type &&
        scopeKey(r.scope) === key
      )
        throw conflict('merchandising rule already exists for this scope', {
          scope_type: rule.scope.type,
          scope_key: key,
        });
    }
    const now = new Date().toISOString();
    const row: MerchandisingRule = {
      id: this.nextId(),
      store_id: rule.storeId,
      scope: rule.scope,
      pins: [...rule.pins],
      boosts: rule.boosts.map((b) => ({ ...b })),
      buries: [...rule.buries],
      enabled: rule.enabled,
      starts_at: rule.starts_at,
      ends_at: rule.ends_at,
      published_at: null,
      created_at: now,
      updated_at: now,
    };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }

  async update(
    _tx: Queryable,
    storeId: string,
    id: string,
    patch: MerchandisingRulePatch,
  ): Promise<MerchandisingRule | null> {
    const r = this.rows.get(id);
    if (!r || r.store_id !== storeId) return null;
    if (patch.pins) r.pins = [...patch.pins];
    if (patch.boosts) r.boosts = patch.boosts.map((b) => ({ ...b }));
    if (patch.buries) r.buries = [...patch.buries];
    if (patch.enabled !== undefined) r.enabled = patch.enabled;
    if (patch.starts_at !== undefined) r.starts_at = patch.starts_at;
    if (patch.ends_at !== undefined) r.ends_at = patch.ends_at;
    r.updated_at = new Date().toISOString();
    return structuredClone(r);
  }

  async delete(_tx: Queryable, storeId: string, id: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.store_id !== storeId) return false;
    this.rows.delete(id);
    return true;
  }

  async markPublished(_tx: Queryable, storeId: string, ids: string[], at: Date): Promise<void> {
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r && r.store_id === storeId) r.published_at = at.toISOString();
    }
  }
}

// -------------------------------------------------------------------------------------------------- postgres

interface Row {
  id: string;
  store_id: string;
  scope_type: 'category' | 'query';
  scope_key: string;
  category_id: string | null;
  pins: string[];
  boosts: MerchandisingRule['boosts'];
  buries: string[];
  enabled: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS =
  'id, store_id, scope_type, scope_key, category_id, pins, boosts, buries, enabled, starts_at, ends_at, published_at, created_at, updated_at';

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function fromRow(r: Row): MerchandisingRule {
  const scope: MerchandisingScope =
    r.scope_type === 'category'
      ? { type: 'category', category_id: r.category_id ?? r.scope_key }
      : { type: 'query', query: r.scope_key };
  return {
    id: r.id,
    store_id: r.store_id,
    scope,
    pins: r.pins ?? [],
    boosts: r.boosts ?? [],
    buries: r.buries ?? [],
    enabled: r.enabled,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    published_at: iso(r.published_at),
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

export class PgRulesRepository implements RulesRepository {
  async list(tx: Queryable, storeId: string): Promise<MerchandisingRule[]> {
    const r = await tx.query<Row>(
      `SELECT ${COLS} FROM merchandising_rule WHERE store_id = $1 ORDER BY updated_at DESC, id`,
      [storeId],
    );
    return r.rows.map(fromRow);
  }

  async get(tx: Queryable, storeId: string, id: string): Promise<MerchandisingRule | null> {
    const r = await tx.query<Row>(
      `SELECT ${COLS} FROM merchandising_rule WHERE store_id = $1 AND id = $2`,
      [storeId, id],
    );
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }

  async create(tx: Queryable, rule: NewRule): Promise<MerchandisingRule> {
    const r = await tx
      .query<Row>(
        `INSERT INTO merchandising_rule (organization_id, store_id, scope_type, scope_key, category_id, pins, boosts, buries, enabled, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
         RETURNING ${COLS}`,
        [
          rule.organizationId,
          rule.storeId,
          rule.scope.type,
          scopeKey(rule.scope),
          rule.scope.type === 'category' ? rule.scope.category_id : null,
          JSON.stringify(rule.pins),
          JSON.stringify(rule.boosts),
          JSON.stringify(rule.buries),
          rule.enabled,
          rule.starts_at,
          rule.ends_at,
        ],
      )
      .catch((err) => mapPgError(err, 'merchandising rule'));
    return fromRow(r.rows[0]!);
  }

  async update(
    tx: Queryable,
    storeId: string,
    id: string,
    patch: MerchandisingRulePatch,
  ): Promise<MerchandisingRule | null> {
    const sets: string[] = [];
    const params: unknown[] = [storeId, id];
    const set = (col: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (patch.pins) set('pins', JSON.stringify(patch.pins), '::jsonb');
    if (patch.boosts) set('boosts', JSON.stringify(patch.boosts), '::jsonb');
    if (patch.buries) set('buries', JSON.stringify(patch.buries), '::jsonb');
    if (patch.enabled !== undefined) set('enabled', patch.enabled);
    if (patch.starts_at !== undefined) set('starts_at', patch.starts_at);
    if (patch.ends_at !== undefined) set('ends_at', patch.ends_at);
    if (sets.length === 0) return this.get(tx, storeId, id);
    const r = await tx
      .query<Row>(
        `UPDATE merchandising_rule SET ${sets.join(', ')} WHERE store_id = $1 AND id = $2 RETURNING ${COLS}`,
        params,
      )
      .catch((err) => mapPgError(err, 'merchandising rule'));
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }

  async delete(tx: Queryable, storeId: string, id: string): Promise<boolean> {
    const r = await tx.query(`DELETE FROM merchandising_rule WHERE store_id = $1 AND id = $2`, [
      storeId,
      id,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async markPublished(tx: Queryable, storeId: string, ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await tx.query(
      `UPDATE merchandising_rule SET published_at = $3 WHERE store_id = $1 AND id = ANY($2)`,
      [storeId, ids, at],
    );
  }
}
