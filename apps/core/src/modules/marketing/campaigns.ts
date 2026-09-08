// Campaign CRUD and the launch/end transitions (issue #145, Admin API 0.3.0 + migration 0120).
// Rules that hold for every function here:
//   * the caller passes a store-scoped `ScopedClient`; every statement also filters `store_id` explicitly, so a
//     mistake in the RLS context cannot silently widen a query;
//   * `campaign.launched` / `campaign.ended` are written to the outbox in the SAME transaction as the status
//     change (ADR 0003) — nothing here ever publishes to the bus;
//   * marketing never touches orders, prices or stock. The only tables written are `campaign` and `audit_log`.
import type { Queryable, ScopedClient } from '@platform/db';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { conflict, mapPgError, notFound, validationError } from '../../lib/errors';
import {
  CAMPAIGN_SORT_FIELDS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  ENDABLE,
  LAUNCHABLE,
  type Campaign,
  type CampaignInput,
  type CampaignListQuery,
  type CampaignRow,
  type CampaignType,
  type Page,
} from './types';

const CURRENCY = /^[A-Z]{3}$/;
const MAX_NAME = 200;

function organizationOf(client: ScopedClient): string {
  return client.context.organizationId;
}

/** The table row as the contract's `Campaign`: two money columns become one `Money`, dates become ISO strings. */
export function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    store_id: row.store_id,
    name: row.name,
    type: row.type,
    status: row.status,
    starts_at: row.starts_at ? row.starts_at.toISOString() : null,
    ends_at: row.ends_at ? row.ends_at.toISOString() : null,
    budget:
      row.budget_minor === null || row.currency === null
        ? null
        : { amount_minor: Number(row.budget_minor), currency: row.currency },
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    promotion_id: row.promotion_id,
    segment_id: row.segment_id,
    landing_path: row.landing_path,
    external_ref: row.external_ref,
    launched_at: row.launched_at ? row.launched_at.toISOString() : null,
    ended_at: row.ended_at ? row.ended_at.toISOString() : null,
    metadata: row.metadata ?? {},
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function timestamp(value: unknown, field: string, problems: Record<string, string>): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    problems[field] = 'date-time';
    return null;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    problems[field] = 'date-time';
    return null;
  }
  return new Date(t).toISOString();
}

function text(value: unknown, field: string, problems: Record<string, string>): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    problems[field] = 'string';
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

interface NormalisedInput {
  name: string;
  type: CampaignType;
  starts_at: string | null;
  ends_at: string | null;
  budget_minor: number | null;
  currency: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  promotion_id: string | null;
  segment_id: string | null;
  landing_path: string | null;
  external_ref: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Validates a `CampaignInput` beyond what the OpenAPI body schema checks (the service is also called directly by
 * jobs and tests) and normalises it into column values. The two table CHECKs of migration 0120 —
 * `budget_minor IS NULL OR currency IS NOT NULL` and `ends_at >= starts_at` — are enforced here as
 * `validation_error`, so the API answers 400 with a field name rather than a Postgres constraint name.
 */
export function normaliseCampaignInput(input: CampaignInput): NormalisedInput {
  const problems: Record<string, string> = {};
  const name = text(input.name, 'name', problems);
  if (!name) problems.name ??= 'non-empty string';
  else if (name.length > MAX_NAME) problems.name = `at most ${MAX_NAME} characters`;
  if (!CAMPAIGN_TYPES.includes(input.type)) problems.type = `one of ${CAMPAIGN_TYPES.join(', ')}`;

  const startsAt = timestamp(input.starts_at, 'starts_at', problems);
  const endsAt = timestamp(input.ends_at, 'ends_at', problems);
  if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
    problems.ends_at = 'must not be before starts_at';
  }

  let budgetMinor: number | null = null;
  let currency: string | null = null;
  if (input.budget !== undefined && input.budget !== null) {
    const amount = (input.budget as { amount_minor?: unknown }).amount_minor;
    const cur = (input.budget as { currency?: unknown }).currency;
    if (!Number.isInteger(amount) || (amount as number) < 0) {
      problems['budget.amount_minor'] = 'integer >= 0 (minor units)';
    } else budgetMinor = amount as number;
    if (typeof cur !== 'string' || !CURRENCY.test(cur)) {
      problems['budget.currency'] = 'ISO-4217 code, upper case';
    } else currency = cur;
  }

  const metadata = input.metadata ?? {};
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    problems.metadata = 'object';
  }

  const normalised: NormalisedInput = {
    name: name ?? '',
    type: input.type,
    starts_at: startsAt,
    ends_at: endsAt,
    budget_minor: budgetMinor,
    currency,
    utm_source: text(input.utm_source, 'utm_source', problems),
    utm_medium: text(input.utm_medium, 'utm_medium', problems),
    utm_campaign: text(input.utm_campaign, 'utm_campaign', problems),
    promotion_id: text(input.promotion_id, 'promotion_id', problems),
    segment_id: text(input.segment_id, 'segment_id', problems),
    landing_path: text(input.landing_path, 'landing_path', problems),
    external_ref: text(input.external_ref, 'external_ref', problems),
    metadata: metadata as Record<string, unknown>,
  };
  if (Object.keys(problems).length) throw validationError('invalid campaign', problems);
  return normalised;
}

const COLUMNS = `id, organization_id, store_id, name, type, status, starts_at, ends_at, budget_minor, currency,
  utm_source, utm_medium, utm_campaign, promotion_id, segment_id, landing_path, external_ref,
  launched_at, ended_at, metadata, created_at, updated_at`;

export async function listCampaigns(
  client: ScopedClient,
  storeId: string,
  query: CampaignListQuery = {},
): Promise<Page<Campaign>> {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const sort = CAMPAIGN_SORT_FIELDS.includes(query.sort as never) ? query.sort! : 'created_at';
  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  const params: unknown[] = [storeId];
  const where = ['store_id = $1'];
  if (query.status) {
    if (!CAMPAIGN_STATUSES.includes(query.status)) {
      throw validationError('invalid status', { status: `one of ${CAMPAIGN_STATUSES.join(', ')}` });
    }
    params.push(query.status);
    where.push(`status = $${params.length}`);
  }
  if (query.type) {
    if (!CAMPAIGN_TYPES.includes(query.type)) {
      throw validationError('invalid type', { type: `one of ${CAMPAIGN_TYPES.join(', ')}` });
    }
    params.push(query.type);
    where.push(`type = $${params.length}`);
  }
  const filter = where.join(' AND ');
  const counted = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM campaign WHERE ${filter}`,
    params,
  );
  const total = Number(counted.rows[0]?.total ?? 0);
  // `sort` and `order` are constrained to the contract's enums above, never interpolated from raw input.
  // NULLS LAST keeps campaigns without a schedule at the end of a `starts_at` sort instead of on top.
  const rows = await client.query<CampaignRow>(
    `SELECT ${COLUMNS} FROM campaign WHERE ${filter}
      ORDER BY ${sort} ${order} NULLS LAST, id ${order}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, (page - 1) * limit],
  );
  return { page, limit, total, items: rows.rows.map(toCampaign) };
}

async function loadRow(q: Queryable, storeId: string, id: string): Promise<CampaignRow> {
  const res = await q.query<CampaignRow>(
    `SELECT ${COLUMNS} FROM campaign WHERE store_id = $1 AND id = $2`,
    [storeId, id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('campaign', id);
  return row;
}

export async function getCampaign(
  client: ScopedClient,
  storeId: string,
  id: string,
): Promise<Campaign> {
  return toCampaign(await loadRow(client, storeId, id));
}

export async function createCampaign(
  client: ScopedClient,
  storeId: string,
  input: CampaignInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Campaign> {
  const v = normaliseCampaignInput(input);
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    // Always `draft`: the contract's createCampaign summary says so, and launching is its own audited operation.
    const inserted = await tx
      .query<CampaignRow>(
        `INSERT INTO campaign (organization_id, store_id, name, type, status, starts_at, ends_at, budget_minor,
                               currency, utm_source, utm_medium, utm_campaign, promotion_id, segment_id,
                               landing_path, external_ref, metadata)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING ${COLUMNS}`,
        [
          organizationId,
          storeId,
          v.name,
          v.type,
          v.starts_at,
          v.ends_at,
          v.budget_minor,
          v.currency,
          v.utm_source,
          v.utm_medium,
          v.utm_campaign,
          v.promotion_id,
          v.segment_id,
          v.landing_path,
          v.external_ref,
          JSON.stringify(v.metadata),
        ],
      )
      .catch((e) => mapPgError(e, `campaign "${v.name}"`));
    const campaign = toCampaign(inserted.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: campaign.id,
      after: campaign,
    });
    return campaign;
  });
}

export async function updateCampaign(
  client: ScopedClient,
  storeId: string,
  id: string,
  input: CampaignInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Campaign> {
  const v = normaliseCampaignInput(input);
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const before = toCampaign(await loadRow(tx, storeId, id));
    // An ended campaign is the historical record the attribution report reads against: editing its utm_campaign
    // would silently rewrite which orders belong to it. End state is final; create a new campaign instead.
    if (before.status === 'ended') {
      throw conflict('an ended campaign cannot be edited', { status: before.status });
    }
    const updated = await tx
      .query<CampaignRow>(
        `UPDATE campaign SET name = $3, type = $4, starts_at = $5, ends_at = $6, budget_minor = $7, currency = $8,
                             utm_source = $9, utm_medium = $10, utm_campaign = $11, promotion_id = $12,
                             segment_id = $13, landing_path = $14, external_ref = $15, metadata = $16
          WHERE store_id = $1 AND id = $2
         RETURNING ${COLUMNS}`,
        [
          storeId,
          id,
          v.name,
          v.type,
          v.starts_at,
          v.ends_at,
          v.budget_minor,
          v.currency,
          v.utm_source,
          v.utm_medium,
          v.utm_campaign,
          v.promotion_id,
          v.segment_id,
          v.landing_path,
          v.external_ref,
          JSON.stringify(v.metadata),
        ],
      )
      .catch((e) => mapPgError(e, `campaign "${v.name}"`));
    const after = toCampaign(updated.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'campaign.update',
      entityType: 'campaign',
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

export async function deleteCampaign(
  client: ScopedClient,
  storeId: string,
  id: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<void> {
  const organizationId = organizationOf(client);
  await client.transaction(async (tx) => {
    const before = toCampaign(await loadRow(tx, storeId, id));
    // The contract: "Delete a draft campaign (409 once launched; end it instead)".
    if (before.status !== 'draft') {
      throw conflict('only a draft campaign can be deleted; end it instead', {
        status: before.status,
      });
    }
    await tx.query(`DELETE FROM campaign WHERE store_id = $1 AND id = $2`, [storeId, id]);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'campaign.delete',
      entityType: 'campaign',
      entityId: id,
      before,
    });
  });
}

/**
 * Payload shared by `campaign.launched` and `campaign.ended` (identical schemas by design, "so consumers close
 * what they opened"). Optional properties are OMITTED rather than sent as null: their schemas are `$ref`s to the
 * uuid / timestamp / money definitions, which do not accept null. No PII — ids, amounts and utm strings only.
 */
function campaignEventPayload(c: Campaign) {
  return {
    campaign_id: c.id,
    name: c.name,
    type: c.type,
    utm_source: c.utm_source ?? null,
    utm_medium: c.utm_medium ?? null,
    utm_campaign: c.utm_campaign ?? null,
    ...(c.promotion_id ? { promotion_id: c.promotion_id } : {}),
    ...(c.segment_id ? { segment_id: c.segment_id } : {}),
    ...(c.budget ? { budget: c.budget } : {}),
    ...(c.starts_at ? { starts_at: c.starts_at } : {}),
    ...(c.ends_at ? { ends_at: c.ends_at } : {}),
  };
}

async function transition(
  client: ScopedClient,
  storeId: string,
  id: string,
  to: 'active' | 'ended',
  actor: Actor,
): Promise<Campaign> {
  const organizationId = organizationOf(client);
  const launching = to === 'active';
  const allowed = launching ? LAUNCHABLE : ENDABLE;
  const topic = launching ? ('campaign.launched' as const) : ('campaign.ended' as const);
  const stamp = launching ? 'launched_at' : 'ended_at';
  return client.transaction(async (tx) => {
    const before = toCampaign(await loadRow(tx, storeId, id));
    if (!allowed.includes(before.status)) {
      throw conflict(
        `a campaign in status ${before.status} cannot be ${launching ? 'launched' : 'ended'}`,
        { status: before.status, allowed: [...allowed] },
      );
    }
    const now = new Date();
    // A relaunched (paused → active) campaign keeps its first launched_at: the report and the accounting spend
    // line both anchor on when the campaign first went live, not on the last resume.
    const updated = await tx.query<CampaignRow>(
      `UPDATE campaign SET status = $3, ${stamp} = COALESCE(${stamp}, $4)
        WHERE store_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [storeId, id, to, now],
    );
    const after = toCampaign(updated.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: launching ? 'campaign.launch' : 'campaign.end',
      entityType: 'campaign',
      entityId: id,
      before,
      after,
    });
    await withEvents(tx, [
      await buildEvent({
        topic,
        organizationId,
        storeId,
        aggregateType: 'campaign',
        aggregateId: id,
        occurredAt: now,
        ...(actor.id ? { actor: eventActor(actor) } : {}),
        payload: campaignEventPayload(after),
      }),
    ]);
    return after;
  });
}

/** draft/scheduled/paused → active, emits `campaign.launched` in the same transaction. */
export async function launchCampaign(
  client: ScopedClient,
  storeId: string,
  id: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Campaign> {
  return transition(client, storeId, id, 'active', actor);
}

/** active/paused → ended, emits `campaign.ended` in the same transaction. */
export async function endCampaign(
  client: ScopedClient,
  storeId: string,
  id: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Campaign> {
  return transition(client, storeId, id, 'ended', actor);
}
