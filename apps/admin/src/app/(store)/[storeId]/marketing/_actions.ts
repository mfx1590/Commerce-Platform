'use server';

/**
 * Server actions for the Marketing section.
 *
 * `src/app/actions/` is window 4's folder, so these live inside the section instead. Same contract as theirs:
 * an action never throws at the form — a refusal is data (`ActionResult`), so a 403 renders the same panel
 * whether it came from loading a screen or from pressing a button.
 *
 * Every action refuses first, before any API call, unless the principal holds the operation's
 * `x-permission` on the store (`refuseUnlessPermitted`, `MARKETING_PERMISSIONS` pinned to the yaml; #925).
 *
 * Every action is bound with `.bind(null, …)` at the call site rather than wrapped in an arrow function: an
 * arrow wrapper does not cross the server/client boundary (Memory-main global gotchas).
 */

import { revalidatePath } from 'next/cache';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import type { AdminComponents } from '@/lib/api/admin-client';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  createCampaign,
  createFeed,
  createSegment,
  endCampaign,
  launchCampaign,
  materializeSegment,
  previewSegment,
  publishFeed,
  updateSegment,
} from './_api';

type Campaign = AdminComponents['Campaign'];
type Segment = AdminComponents['Segment'];
type ProductFeed = AdminComponents['ProductFeed'];

function revalidateCampaigns(storeId: string): void {
  revalidatePath(`/${storeId}/marketing/campaigns`);
  revalidatePath(`/${storeId}/marketing`);
}

function revalidateSegments(storeId: string): void {
  revalidatePath(`/${storeId}/marketing/segments`);
}

function revalidateFeeds(storeId: string): void {
  revalidatePath(`/${storeId}/marketing/feeds`);
}

// ---------------------------------------------------------------------------- campaigns

/** draft/scheduled/paused → active. `store_admin`; a 409 means someone else moved it first. */
export async function launchCampaignAction(
  storeId: string,
  campaignId: string,
): Promise<ActionResult<Campaign>> {
  const refused = await refuseUnlessPermitted('launchCampaign', storeId);
  if (refused) return refused;
  const result = await launchCampaign(storeId, campaignId);
  if (result.ok) revalidateCampaigns(storeId);
  return toActionResult(result, []);
}

/** active/paused → ended. Final: the attribution report reads an ended campaign as history. */
export async function endCampaignAction(
  storeId: string,
  campaignId: string,
): Promise<ActionResult<Campaign>> {
  const refused = await refuseUnlessPermitted('endCampaign', storeId);
  if (refused) return refused;
  const result = await endCampaign(storeId, campaignId);
  if (result.ok) revalidateCampaigns(storeId);
  return toActionResult(result, []);
}

const CAMPAIGN_FIELDS = [
  'name',
  'type',
  'starts_at',
  'ends_at',
  'budget',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'landing_path',
  'external_ref',
] as const;

export async function createCampaignAction(
  storeId: string,
  body: AdminComponents['CampaignInput'],
): Promise<ActionResult<Campaign>> {
  const refused = await refuseUnlessPermitted('createCampaign', storeId);
  if (refused) return refused;
  const result = await createCampaign(storeId, body);
  if (result.ok) revalidateCampaigns(storeId);
  return toActionResult(result, CAMPAIGN_FIELDS);
}

// ---------------------------------------------------------------------------- segments

const SEGMENT_FIELDS = ['name', 'description', 'rules', 'template_id'] as const;

export async function createSegmentAction(
  storeId: string,
  body: AdminComponents['SegmentInput'],
): Promise<ActionResult<Segment>> {
  const refused = await refuseUnlessPermitted('createSegment', storeId);
  if (refused) return refused;
  const result = await createSegment(storeId, body);
  if (result.ok) revalidateSegments(storeId);
  return toActionResult(result, SEGMENT_FIELDS);
}

export async function updateSegmentAction(
  storeId: string,
  segmentId: string,
  body: AdminComponents['SegmentInput'],
): Promise<ActionResult<Segment>> {
  const refused = await refuseUnlessPermitted('updateSegment', storeId);
  if (refused) return refused;
  const result = await updateSegment(storeId, segmentId, body);
  if (result.ok) revalidateSegments(storeId);
  return toActionResult(result, SEGMENT_FIELDS);
}

/**
 * The live count behind the rule builder. Writes nothing — `rules` in the body overrides the saved ones, so a
 * marketer can see who a rule set matches before there is anything to save.
 */
export async function previewSegmentAction(
  storeId: string,
  segmentId: string,
  rules: AdminComponents['SegmentRules'],
): Promise<ActionResult<{ count: number }>> {
  const refused = await refuseUnlessPermitted('previewSegment', storeId);
  if (refused) return refused;
  return toActionResult(await previewSegment(storeId, segmentId, rules), ['rules']);
}

/** Refreshes `segment_member`. 202: the contract calls it a job, so the screen says "queued", not "done". */
export async function materializeSegmentAction(
  storeId: string,
  segmentId: string,
): Promise<ActionResult<Segment>> {
  const refused = await refuseUnlessPermitted('materializeSegment', storeId);
  if (refused) return refused;
  const result = await materializeSegment(storeId, segmentId);
  if (result.ok) revalidateSegments(storeId);
  return toActionResult(result, []);
}

// ---------------------------------------------------------------------------- feeds

const FEED_FIELDS = [
  'name',
  'channel',
  'locale',
  'currency',
  'filters',
  'mapping',
  'status',
] as const;

export async function createFeedAction(
  storeId: string,
  body: AdminComponents['ProductFeedInput'],
): Promise<ActionResult<ProductFeed>> {
  const refused = await refuseUnlessPermitted('createFeed', storeId);
  if (refused) return refused;
  const result = await createFeed(storeId, body);
  if (result.ok) revalidateFeeds(storeId);
  return toActionResult(result, FEED_FIELDS);
}

/** Generates the file and stores it. A 409 means the channel has no writer yet (tiktok, pinterest). */
export async function publishFeedAction(
  storeId: string,
  feedId: string,
): Promise<ActionResult<ProductFeed>> {
  const refused = await refuseUnlessPermitted('publishFeed', storeId);
  if (refused) return refused;
  const result = await publishFeed(storeId, feedId);
  if (result.ok) {
    revalidateFeeds(storeId);
    revalidatePath(`/${storeId}/marketing/feeds/${feedId}`);
  }
  return toActionResult(result, []);
}
