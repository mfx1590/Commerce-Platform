'use server';

import { revalidatePath } from 'next/cache';
import {
  createMerchandisingRule,
  deleteMerchandisingRule,
  listCategories,
  listMerchandisingRules,
  listProducts,
  publishMerchandisingRules,
  updateMerchandisingRule,
} from '@/lib/api/admin';
import {
  draftToInput,
  draftToPatch,
  filterRules,
  publishOutcomes,
  RULE_FILTER_KEYS,
  ruleProblems,
  scopeLabel,
  type MerchandisingRule,
  type PublishReport,
  type RuleDraft,
} from '@/lib/catalog/merchandising';
import { actionError, toActionResult, type ActionResult } from '@/lib/forms/action-result';
import { mapServerError } from '@/lib/forms/server-errors';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import { outcomeOf, type BulkReport, type BulkSelection } from '@/lib/table/bulk';
import { runStoreBulkAction } from '@/lib/table/bulk-server';
import { refuseUnlessSection } from '@/lib/table/export-server';

/**
 * Search merchandising rules (#870 wave 1 item 5, PR C; Opus review). Reading needs store_staff,
 * every change and the publish store_admin — each action refuses before the API, and the bulk
 * actions again per row (`runStoreBulkAction`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RULE_FIELDS = ['scope', 'pins', 'boosts', 'buries', 'enabled', 'starts_at', 'ends_at'];

function revalidateRules(storeId: string): void {
  revalidatePath(`/${storeId}/catalog/merchandising`);
}

function invalid(problems: Record<string, string>): ActionResult<never> {
  const { form, ...fieldErrors } = problems;
  return actionError({ fieldErrors, formError: form ?? 'Fix the fields marked below.' });
}

/** The product picker: products by title or handle, 20 at a time (catalog readers). */
export async function searchProductsForRuleAction(
  storeId: string,
  q: string,
): Promise<ActionResult<{ id: string; title: string; status: string }[]>> {
  const refused = await refuseUnlessSection(storeId, 'catalog');
  if (refused !== null) return refused;
  const query = q.trim().slice(0, 200);
  if (query === '') return { status: 'success', data: [] };
  const result = await listProducts(storeId, { q: query, limit: 20, page: 1 });
  if (!result.ok) return toActionResult(result, []);
  return {
    status: 'success',
    data: result.data.items.map((p) => ({ id: p.id, title: p.title, status: p.status })),
  };
}

export async function createRuleAction(
  storeId: string,
  draft: RuleDraft,
): Promise<ActionResult<MerchandisingRule>> {
  const refused = await refuseUnlessPermitted('createMerchandisingRule', storeId);
  if (refused !== null) return refused;
  const problems = ruleProblems(draft);
  if (Object.keys(problems).length > 0) return invalid(problems);
  const result = await createMerchandisingRule(storeId, draftToInput(draft));
  if (!result.ok && result.status === 409) {
    return actionError({
      fieldErrors: { scope: 'This scope already has a rule: edit that one instead.' },
      formError: null,
    });
  }
  if (result.ok) revalidateRules(storeId);
  return toActionResult(result, RULE_FIELDS);
}

/** Everything but the scope (immutable); pins, boosts and buries replace the whole lists. */
export async function updateRuleAction(
  storeId: string,
  ruleId: string,
  draft: RuleDraft,
): Promise<ActionResult<MerchandisingRule>> {
  const refused = await refuseUnlessPermitted('updateMerchandisingRule', storeId);
  if (refused !== null) return refused;
  if (!UUID.test(ruleId))
    return actionError({ fieldErrors: {}, formError: 'That rule is not valid.' });
  const problems = ruleProblems(draft);
  delete problems['scope'];
  if (Object.keys(problems).length > 0) return invalid(problems);
  const result = await updateMerchandisingRule(storeId, ruleId, draftToPatch(draft));
  if (result.ok) revalidateRules(storeId);
  return toActionResult(result, RULE_FIELDS);
}

// ------------------------------------------------------------------------------------ bulk

type BulkKind = 'enable' | 'disable' | 'delete';

const DONE: Record<BulkKind, string> = {
  enable: 'Enabled; in the index after the next publish.',
  disable: 'Disabled; out of the index after the next publish.',
  delete: 'Deleted; out of the index after the next publish.',
};

/**
 * Enable, disable or delete the ticked rules, or every rule matching the screen's filters. The
 * API has no filters or paging for rules: "all matching" re-reads the full list and applies the
 * screen's own filters here, at the time of the action.
 */
export async function bulkRulesAction(
  storeId: string,
  selection: BulkSelection,
  kind: BulkKind,
): Promise<ActionResult<BulkReport>> {
  if (!(kind in DONE)) return actionError({ fieldErrors: {}, formError: 'Unknown action.' });
  const now = new Date();
  let categoryNames: Record<string, string> = {};
  const labelOf = (rule: MerchandisingRule) => scopeLabel(rule.scope, categoryNames);
  return runStoreBulkAction<MerchandisingRule>({
    operation: kind === 'delete' ? 'deleteMerchandisingRule' : 'updateMerchandisingRule',
    storeId,
    selection,
    filterKeys: RULE_FILTER_KEYS,
    idOf: (rule) => rule.id,
    labelOf,
    listPage: (filters) => async (page, limit) => {
      const [rules, categories] = await Promise.all([
        listMerchandisingRules(storeId),
        listCategories(storeId),
      ]);
      if (categories.ok) {
        categoryNames = Object.fromEntries(categories.data.items.map((c) => [c.id, c.name]));
      }
      if (!rules.ok) return rules;
      const matching = filterRules(rules.data.items, filters, now);
      return {
        ok: true,
        data: { items: matching.slice((page - 1) * limit, page * limit), total: matching.length },
      };
    },
    perRow: async (ruleId, rule) => {
      if (!UUID.test(ruleId)) return { outcome: 'failed', message: 'Not a rule id.' };
      if (kind === 'delete')
        return outcomeOf(await deleteMerchandisingRule(storeId, ruleId), DONE.delete);
      const enabled = kind === 'enable';
      if (rule !== null && rule.enabled === enabled) {
        return { outcome: 'skipped', message: `Already ${enabled ? 'enabled' : 'disabled'}.` };
      }
      const result = await updateMerchandisingRule(storeId, ruleId, { enabled });
      return {
        ...outcomeOf(result, DONE[kind]),
        ...(result.ok ? { label: labelOf(result.data) } : {}),
      };
    },
    revalidate: [`/${storeId}/catalog/merchandising`],
  });
}

// --------------------------------------------------------------------------------- publish

/**
 * "Publish to search": replaces the index's rules with every enabled, in-window rule. The API
 * answers with counts only, so the rules are read back and each one is reported — published (its
 * publish time stamped by this run), skipped (and why), or not confirmed.
 */
export async function publishRulesAction(storeId: string): Promise<ActionResult<PublishReport>> {
  const refused = await refuseUnlessPermitted('publishMerchandisingRules', storeId);
  if (refused !== null) return refused;
  const startedAt = new Date();
  const answer = await publishMerchandisingRules(storeId);
  if (!answer.ok) {
    if (answer.status === 409) {
      return actionError({
        fieldErrors: {},
        formError: `Nothing was published: ${answer.error.message} (the store has no search index or credentials set up).`,
      });
    }
    const failure = { status: answer.status, error: answer.error };
    const refusal = failure.status === 401 || failure.status === 403 ? failure : undefined;
    const mapped = mapServerError(failure);
    return actionError(
      {
        fieldErrors: {},
        formError:
          answer.status === 0 || answer.status >= 500
            ? `The publish did not come back (${answer.error.message}): the index may or may not have the rules. Reload and check the publish times before running it again.`
            : (mapped.formError ?? answer.error.message),
      },
      refusal,
    );
  }
  revalidateRules(storeId);
  const after = await listMerchandisingRules(storeId);
  if (!after.ok) {
    return {
      status: 'success',
      data: {
        index: answer.data.index,
        published: answer.data.published,
        skipped: answer.data.skipped,
        rows: [],
        mismatch: `Published, but the rules could not be read back (${after.error.message}): the result per rule is not known. Reload to see each rule's publish time.`,
      },
    };
  }
  return { status: 'success', data: publishOutcomes(answer.data, after.data.items, startedAt) };
}
