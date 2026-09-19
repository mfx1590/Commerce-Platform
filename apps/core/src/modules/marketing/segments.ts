// Segments: definitions, preview, materialisation and organization templates (#147).
//
// One table, two kinds of row (migration 0120): `store_id` set is a store segment, `store_id IS NULL` is an
// organization **template** every brand can copy. RLS kind `store_nullable` means a template is visible only in
// organization scope — which is the whole reason `createSegment` reads a template through an organization client
// (see the comment on `readTemplateRules`).
//
// Marketing writes `segment`, `segment_member`, `audit_log`. It never touches `customer`, orders or anything else
// it reads.
import type { Queryable, ScopedClient } from '@platform/db';
import { organizationClient } from '../../lib/db';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { conflict, mapPgError, notFound, validationError } from '../../lib/errors';
import { parseSegmentRules, type SegmentRules } from './segment-rules';
import { segmentQuery } from './segment-sql';
import type { Page } from './types';
import type { Segment, SegmentInput, SegmentListQuery, SegmentRow } from './segment-types';
import { SEGMENT_SORT_FIELDS } from './segment-types';

const MAX_NAME = 200;

const COLUMNS = `id, organization_id, store_id, template_id, name, description, rules,
  materialised_count, last_materialised_at, created_at, updated_at`;

export function toSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    store_id: row.store_id,
    template_id: row.template_id,
    name: row.name,
    description: row.description,
    rules: row.rules as SegmentRules,
    materialised_count: row.materialised_count,
    last_materialised_at: row.last_materialised_at ? row.last_materialised_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

interface NormalisedSegment {
  name: string;
  description: string | null;
  rules: SegmentRules;
  template_id: string | null;
}

export function normaliseSegmentInput(input: SegmentInput): NormalisedSegment {
  const problems: Record<string, string> = {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') problems.name = 'non-empty string';
  else if (name.length > MAX_NAME) problems.name = `at most ${MAX_NAME} characters`;

  const description =
    input.description === undefined || input.description === null
      ? null
      : String(input.description).trim() || null;

  if (Object.keys(problems).length) throw validationError('invalid segment', problems);

  // Throws its own `validation_error` naming the exact rule path; nothing to merge into `problems`.
  const rules = parseSegmentRules(input.rules);
  const templateId =
    input.template_id === undefined || input.template_id === null
      ? null
      : String(input.template_id);

  return { name, description, rules, template_id: templateId };
}

async function loadRow(
  q: Queryable,
  scope: { storeId: string } | { template: true },
  id: string,
): Promise<SegmentRow> {
  const res =
    'storeId' in scope
      ? await q.query<SegmentRow>(
          `SELECT ${COLUMNS} FROM segment WHERE store_id = $1 AND id = $2`,
          [scope.storeId, id],
        )
      : await q.query<SegmentRow>(
          `SELECT ${COLUMNS} FROM segment WHERE store_id IS NULL AND id = $1`,
          [id],
        );
  const row = res.rows[0];
  if (!row) throw notFound('segment', id);
  return row;
}

/**
 * The rules of an organization template, read in **organization scope**.
 *
 * Templates exist so every brand can copy them ("Organization-level segments (store_id null) every brand can
 * copy"), and `createSegment` is gated on `store_admin` for the store — not on an HQ role. A store admin has no
 * organization relations, so RLS kind `store_nullable` hides the template from the caller's own tenant client
 * and `organizationClientFor(principal)` would refuse outright. The read is the operation's own business after
 * the route has authorised it, so it runs on an organization-scoped client bound to the same organization and
 * actor. It reads one row and never writes.
 *
 * The client is injected (`templateClient`) rather than always built here: a service that reaches for the
 * process-global pool cannot be tested without `initDb()`, and a seam is cheaper than that coupling. Callers
 * that have no reason to care — the route — omit it and get the default.
 */
async function readTemplateRules(
  organizationId: string,
  actorId: string | null,
  templateId: string,
  templateClient?: ScopedClient,
): Promise<SegmentRules> {
  const client =
    templateClient ??
    organizationClient({
      organizationId,
      ...(actorId ? { actorId } : {}),
    });
  const res = await client.query<{ rules: unknown }>(
    `SELECT rules FROM segment WHERE id = $1 AND store_id IS NULL`,
    [templateId],
  );
  const row = res.rows[0];
  if (!row) {
    throw validationError('unknown segment template', {
      template_id: 'no such organization template',
    });
  }
  return parseSegmentRules(row.rules);
}

function listSql(query: SegmentListQuery, scoped: string, params: unknown[]) {
  const sort = SEGMENT_SORT_FIELDS.includes(query.sort as never) ? query.sort! : 'created_at';
  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  return {
    count: `SELECT count(*)::text AS total FROM segment WHERE ${scoped}`,
    rows: `SELECT ${COLUMNS} FROM segment WHERE ${scoped}
            ORDER BY ${sort} ${order} NULLS LAST, id ${order}
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    page,
    limit,
  };
}

export async function listSegments(
  client: ScopedClient,
  storeId: string,
  query: SegmentListQuery = {},
): Promise<Page<Segment>> {
  const params: unknown[] = [storeId];
  const sql = listSql(query, 'store_id = $1', params);
  const counted = await client.query<{ total: string }>(sql.count, params);
  const rows = await client.query<SegmentRow>(sql.rows, [
    ...params,
    sql.limit,
    (sql.page - 1) * sql.limit,
  ]);
  return {
    page: sql.page,
    limit: sql.limit,
    total: Number(counted.rows[0]?.total ?? 0),
    items: rows.rows.map(toSegment),
  };
}

/** Organization templates. The caller must pass an organization-scoped client or RLS returns nothing. */
export async function listSegmentTemplates(
  client: ScopedClient,
  query: SegmentListQuery = {},
): Promise<Page<Segment>> {
  const params: unknown[] = [];
  const sql = listSql(query, 'store_id IS NULL', params);
  const counted = await client.query<{ total: string }>(sql.count, params);
  const rows = await client.query<SegmentRow>(sql.rows, [sql.limit, (sql.page - 1) * sql.limit]);
  return {
    page: sql.page,
    limit: sql.limit,
    total: Number(counted.rows[0]?.total ?? 0),
    items: rows.rows.map(toSegment),
  };
}

export async function getSegment(
  client: ScopedClient,
  storeId: string,
  id: string,
): Promise<Segment> {
  return toSegment(await loadRow(client, { storeId }, id));
}

export async function getSegmentTemplate(client: ScopedClient, id: string): Promise<Segment> {
  return toSegment(await loadRow(client, { template: true }, id));
}

async function insert(
  client: ScopedClient,
  storeId: string | null,
  v: NormalisedSegment,
  actor: Actor,
): Promise<Segment> {
  const organizationId = client.context.organizationId;
  return client.transaction(async (tx) => {
    const inserted = await tx
      .query<SegmentRow>(
        `INSERT INTO segment (organization_id, store_id, template_id, name, description, rules)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [organizationId, storeId, v.template_id, v.name, v.description, JSON.stringify(v.rules)],
      )
      .catch((e) => mapPgError(e, `segment "${v.name}"`));
    const segment = toSegment(inserted.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: storeId === null ? 'segment_template.create' : 'segment.create',
      entityType: 'segment',
      entityId: segment.id,
      after: segment,
    });
    return segment;
  });
}

/**
 * Creates a store segment. With `template_id` the rules are **copied** from the organization template at
 * creation (the contract's wording) — the segment then owns them, so editing the template later never silently
 * changes who a live campaign reaches, and deleting the template leaves the segment working.
 */
export async function createSegment(
  client: ScopedClient,
  storeId: string,
  input: SegmentInput,
  actor: Actor = SYSTEM_ACTOR,
  /** Organization-scoped client for the template read; defaults to one built from the core pool. */
  templateClient?: ScopedClient,
): Promise<Segment> {
  const v = normaliseSegmentInput(input);
  if (v.template_id) {
    const hasOwnRules = v.rules.all.length > 0;
    if (hasOwnRules) {
      throw validationError('rules and template_id are mutually exclusive', {
        rules: 'omit rules when creating from a template, or omit template_id',
      });
    }
    v.rules = await readTemplateRules(
      client.context.organizationId,
      actor.id ?? null,
      v.template_id,
      templateClient,
    );
  }
  return insert(client, storeId, v, actor);
}

export async function createSegmentTemplate(
  client: ScopedClient,
  input: SegmentInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Segment> {
  const v = normaliseSegmentInput(input);
  if (v.template_id) {
    // Migration 0120's CHECK says so too; this is the readable version of that error.
    throw validationError('a template cannot be created from a template', {
      template_id: 'not allowed on an organization template',
    });
  }
  return insert(client, null, v, actor);
}

async function update(
  client: ScopedClient,
  scope: { storeId: string } | { template: true },
  id: string,
  input: SegmentInput,
  actor: Actor,
): Promise<Segment> {
  const v = normaliseSegmentInput(input);
  const organizationId = client.context.organizationId;
  return client.transaction(async (tx) => {
    const row = await loadRow(tx, scope, id);
    const before = toSegment(row);
    // `template_id` records where the rules came from; it is history, not a live link, so an edit never moves it.
    const updated = await tx
      .query<SegmentRow>(
        `UPDATE segment SET name = $2, description = $3, rules = $4 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, v.name, v.description, JSON.stringify(v.rules)],
      )
      .catch((e) => mapPgError(e, `segment "${v.name}"`));
    const after = toSegment(updated.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId: row.store_id,
      actor,
      action: row.store_id === null ? 'segment_template.update' : 'segment.update',
      entityType: 'segment',
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

export const updateSegment = (
  client: ScopedClient,
  storeId: string,
  id: string,
  input: SegmentInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Segment> => update(client, { storeId }, id, input, actor);

export const updateSegmentTemplate = (
  client: ScopedClient,
  id: string,
  input: SegmentInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Segment> => update(client, { template: true }, id, input, actor);

async function remove(
  client: ScopedClient,
  scope: { storeId: string } | { template: true },
  id: string,
  actor: Actor,
): Promise<void> {
  const organizationId = client.context.organizationId;
  await client.transaction(async (tx) => {
    const row = await loadRow(tx, scope, id);
    const before = toSegment(row);
    if (row.store_id !== null) {
      // A campaign pointing at this segment would be left dangling; `campaign.segment_id` is ON DELETE SET NULL,
      // so the database would quietly unlink it. Refusing is the honest answer.
      const used = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM campaign WHERE segment_id = $1 AND status <> 'ended'`,
        [id],
      );
      if (Number(used.rows[0]?.count ?? 0) > 0) {
        throw conflict('segment is used by a campaign that has not ended', { segment_id: id });
      }
    }
    // `segment_member` cascades (migration 0120); a template has no members.
    await tx.query(`DELETE FROM segment WHERE id = $1`, [id]);
    await writeAudit(tx, {
      organizationId,
      storeId: row.store_id,
      actor,
      action: row.store_id === null ? 'segment_template.delete' : 'segment.delete',
      entityType: 'segment',
      entityId: id,
      before,
    });
  });
}

export const deleteSegment = (
  client: ScopedClient,
  storeId: string,
  id: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<void> => remove(client, { storeId }, id, actor);

export const deleteSegmentTemplate = (
  client: ScopedClient,
  id: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<void> => remove(client, { template: true }, id, actor);

/**
 * How many customers the rules match right now. Writes nothing. `rules` in the body overrides the saved rules,
 * which is what makes a live rule builder possible without saving a draft segment first.
 *
 * Preview and materialise share `segmentQuery`, so the count a marketer sees is the count they get — the
 * acceptance criterion of #147 is a property of the code, not a coincidence two queries happen to share.
 */
export async function previewSegment(
  client: ScopedClient,
  storeId: string,
  id: string,
  override?: unknown,
): Promise<{ count: number }> {
  const row = await loadRow(client, { storeId }, id);
  const rules = override === undefined ? parseSegmentRules(row.rules) : parseSegmentRules(override);
  const q = segmentQuery(rules, 'count(*)::int AS count');
  const res = await client.query<{ count: number }>(q.text, [storeId, ...q.params]);
  return { count: res.rows[0]?.count ?? 0 };
}

/**
 * Replaces `segment_member` with whoever matches now, in one transaction, and updates the counters.
 *
 * Members are replaced rather than merged: a segment is a statement about the present, and `segment_member` has
 * no `updated_at` for exactly that reason (docs/domain.md: "rows are replaced, not edited").
 */
export async function materializeSegment(
  client: ScopedClient,
  storeId: string,
  id: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Segment> {
  const organizationId = client.context.organizationId;
  const row = await loadRow(client, { storeId }, id);
  const rules = parseSegmentRules(row.rules);
  const q = segmentQuery(rules, 'c.id');

  return client.transaction(async (tx) => {
    await tx.query(`DELETE FROM segment_member WHERE segment_id = $1`, [id]);
    const inserted = await tx.query(
      `INSERT INTO segment_member (organization_id, store_id, segment_id, customer_id, materialised_at)
       SELECT $${q.params.length + 2}, $1, $${q.params.length + 3}, matched.id, now()
         FROM (${q.text}) AS matched`,
      [storeId, ...q.params, organizationId, id],
    );
    const count = inserted.rowCount ?? 0;
    const updated = await tx.query<SegmentRow>(
      `UPDATE segment SET materialised_count = $2, last_materialised_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, count],
    );
    const after = toSegment(updated.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'segment.materialize',
      entityType: 'segment',
      entityId: id,
      before: toSegment(row),
      after,
    });
    return after;
  });
}
