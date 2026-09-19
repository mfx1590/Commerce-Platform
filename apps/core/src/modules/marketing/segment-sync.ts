// The sync contract window 16's messaging worker calls to push a segment's members to Klaviyo (#147).
//
// **No provider call happens here, and none ever will.** This module owns who is in a segment; window 16 owns
// delivery, credentials and provider quirks. The boundary is this typed payload and one function — window 16
// imports both from the module's index.ts and never queries `segment_member` itself.
//
// **No PII crosses the boundary.** A member is a customer id plus `email_hash` (sha256 of the lowercased email),
// the same convention the event envelopes use. The worker resolves an address from its own consented store when
// it actually sends; a segment export is not a mailing list and must not become one if it is logged or cached.
import { createHash } from 'node:crypto';
import type { ScopedClient } from '@platform/db';
import { notFound } from '../../lib/errors';
import type { Segment } from './segment-types';
import { toSegment } from './segments';
import type { SegmentRow } from './segment-types';

/** One materialised member. Ids and a hash — never an address, a name or a phone number. */
export interface SegmentSyncMember {
  customer_id: string;
  /** sha256 of the lowercased, trimmed email. */
  email_hash: string;
  /** Channels the customer has granted, from `customer.consent`; the worker must not send outside them. */
  consent: ('email' | 'sms')[];
  materialised_at: string;
}

export interface SegmentSyncPayload {
  segment_id: string;
  store_id: string;
  organization_id: string;
  name: string;
  /** What `materialize` last counted; compare with `members.length` across pages to detect a stale read. */
  materialised_count: number;
  last_materialised_at: string | null;
  members: SegmentSyncMember[];
  /** Pass back as `after` to fetch the next page; null when this is the last one. */
  next_cursor: string | null;
}

export interface SegmentSyncOptions {
  /** Page size, 1..1000 (default 500). */
  limit?: number;
  /** `next_cursor` from the previous page. */
  after?: string;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

interface MemberRow {
  customer_id: string;
  email: string;
  consent: Record<string, { granted?: unknown }> | null;
  materialised_at: Date;
}

function grantedChannels(consent: MemberRow['consent']): ('email' | 'sms')[] {
  const out: ('email' | 'sms')[] = [];
  if (consent?.marketing_email?.granted === true) out.push('email');
  if (consent?.marketing_sms?.granted === true) out.push('sms');
  return out;
}

/**
 * One page of a segment's **materialised** members.
 *
 * Deliberately reads `segment_member` rather than re-evaluating the rules: the worker must send to the set the
 * segment was last materialised as, so that what was previewed, what was counted and what was sent are the same
 * set. Re-evaluating here would let the audience drift between the count a marketer approved and the send.
 */
export async function segmentSyncPayload(
  client: ScopedClient,
  storeId: string,
  segmentId: string,
  options: SegmentSyncOptions = {},
): Promise<SegmentSyncPayload> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const segmentRes = await client.query<SegmentRow>(
    `SELECT id, organization_id, store_id, template_id, name, description, rules,
            materialised_count, last_materialised_at, created_at, updated_at
       FROM segment WHERE store_id = $1 AND id = $2`,
    [storeId, segmentId],
  );
  const row = segmentRes.rows[0];
  if (!row) throw notFound('segment', segmentId);
  const segment: Segment = toSegment(row);

  // Ordered by customer id so the cursor is stable even while a materialise runs underneath.
  const members = await client.query<MemberRow>(
    `SELECT m.customer_id, c.email, c.consent, m.materialised_at
       FROM segment_member m
       JOIN customer c ON c.id = m.customer_id
      WHERE m.segment_id = $1 AND m.store_id = $2 AND ($3::uuid IS NULL OR m.customer_id > $3)
      ORDER BY m.customer_id
      LIMIT $4`,
    [segmentId, storeId, options.after ?? null, limit + 1],
  );

  const page = members.rows.slice(0, limit);
  const hasMore = members.rows.length > limit;

  return {
    segment_id: segment.id,
    store_id: storeId,
    organization_id: row.organization_id,
    name: segment.name,
    materialised_count: segment.materialised_count,
    last_materialised_at: segment.last_materialised_at,
    members: page.map((m) => ({
      customer_id: m.customer_id,
      email_hash: emailHash(m.email),
      consent: grantedChannels(m.consent),
      materialised_at: m.materialised_at.toISOString(),
    })),
    next_cursor: hasMore ? (page[page.length - 1]?.customer_id ?? null) : null,
  };
}
