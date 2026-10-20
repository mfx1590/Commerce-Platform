/**
 * Brand onboarding (#428 B): the wizard's steps, which step owns a field the core complains about,
 * the readiness labels, and the form → `StoreOnboardingInput` builder. Pure, so it is tested in a
 * table.
 *
 * Where the core's answers come from (apps/core/src/modules/registry/onboarding.ts, #424):
 * - 400 `validation_error`: `details` keyed by field — `legal_entity`, `legal_entity.code`, …,
 *   `code`, `name`, `default_*`, `currencies`, `locales`, `domain.hostname`;
 * - 409 on a repeat with a different input: `details.differs` lists the normalised keys that differ
 *   (`legal_entity`, `name`, `default_*`, `timezone`, `currencies`, `locales`, `hostname`, `theme`,
 *   `settings`); 409 on a hostname another store has: `details.field: 'domain.hostname'`;
 * - 422 `InvalidSettings`: `details.settings` maps each offending settings key to what was expected;
 * - `activateStore` 409 `ActivationBlocked`: `details.missing` from a closed list, or
 *   `details.status: archived`.
 */

import { z } from 'zod';
import type { AdminComponents } from '../api/admin-client';

export const STEPS = ['legal_entity', 'store', 'domain', 'review'] as const;
export type Step = (typeof STEPS)[number];

export const STEP_TITLES: Record<Step, string> = {
  legal_entity: 'Legal entity',
  store: 'Store basics',
  domain: 'Primary domain',
  review: 'Review',
};

/** The step whose form owns a field the core named (400 key, 409 `differs` entry, 409 `field`). */
export function stepOfField(field: string): Step {
  if (field === 'legal_entity' || field === 'legal_entity_id' || field.startsWith('legal_entity.'))
    return 'legal_entity';
  if (field === 'hostname' || field === 'domain' || field.startsWith('domain.')) return 'domain';
  return 'store';
}

/** The steps a 409 points at, in wizard order. */
export function conflictSteps(details: Record<string, unknown> | undefined): Step[] {
  const fields: string[] = [];
  const differs = details?.['differs'];
  if (Array.isArray(differs))
    fields.push(...differs.filter((f): f is string => typeof f === 'string'));
  const field = details?.['field'];
  if (typeof field === 'string' && field !== 'code') fields.push(field);
  const steps = new Set(fields.map(stepOfField));
  return STEPS.filter((step) => steps.has(step));
}

/** `activateStore`'s closed list of prerequisites, in words. */
export const MISSING_LABELS: Record<string, string> = {
  legal_entity: 'a legal entity',
  locale: 'a locale',
  currency: 'a currency',
  primary_domain: 'a primary domain',
  publishable_key: 'a live publishable key',
  fga_object: 'its permission object (OpenFGA)',
};

/** The 409's `details.missing`, read safely; unknown entries are kept as they came. */
export function readMissing(details: Record<string, unknown> | undefined): string[] {
  const missing = details?.['missing'];
  return Array.isArray(missing) ? missing.filter((m): m is string => typeof m === 'string') : [];
}

/** "Cannot activate: a primary domain, a live publishable key." */
export function activationMessage(details: Record<string, unknown> | undefined): string {
  if (details?.['status'] === 'archived') {
    return 'Cannot activate: the store is archived. Archived stores are not reactivated here.';
  }
  const missing = readMissing(details);
  if (missing.length === 0) return 'Cannot activate the store yet.';
  return `Cannot activate: ${missing.map((m) => MISSING_LABELS[m] ?? m).join(', ')} missing.`;
}

const code = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens, e.g. brand-c');
const currency = z.string().regex(/^[A-Z]{3}$/, 'Three capital letters, e.g. EUR');
const country = z.string().regex(/^[A-Z]{2}$/, 'Two capital letters, e.g. NL');

/** The wizard's values, step by step. Settings is a JSON object typed in the store step. */
export const onboardingSchema = z.object({
  legal_entity_mode: z.enum(['existing', 'inline']),
  legal_entity_id: z.string(),
  legal_entity: z.object({
    code: z.string(),
    name: z.string(),
    country: z.string(),
    currency: z.string(),
    vat_number: z.string(),
  }),
  code,
  name: z.string().trim().min(1, 'Enter a name'),
  default_currency: currency,
  default_locale: z.string().min(2, 'Enter a locale, e.g. en-GB'),
  default_country: country,
  timezone: z.string().min(1, 'Enter a timezone, e.g. Europe/Amsterdam'),
  currencies: z.array(currency),
  locales: z.array(z.string().min(2)),
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+$/, 'A hostname like shop.brand-c.com — no scheme, no path'),
  settings_json: z.string(),
});
export type OnboardingValues = z.infer<typeof onboardingSchema>;

/** Field problems per step before the request — the server re-validates everything. */
export function stepProblems(values: OnboardingValues, step: Step): Record<string, string> {
  const problems: Record<string, string> = {};
  if (step === 'legal_entity') {
    if (values.legal_entity_mode === 'existing') {
      if (!z.string().uuid().safeParse(values.legal_entity_id).success)
        problems['legal_entity_id'] = 'Choose a legal entity';
    } else {
      const le = values.legal_entity;
      if (!code.safeParse(le.code).success)
        problems['legal_entity.code'] = 'Lowercase kebab-case, e.g. brand-c-bv';
      if (le.name.trim() === '') problems['legal_entity.name'] = 'Enter the registered name';
      if (!country.safeParse(le.country).success)
        problems['legal_entity.country'] = 'Two capital letters, e.g. NL';
      if (!currency.safeParse(le.currency).success)
        problems['legal_entity.currency'] = 'Three capital letters, e.g. EUR';
    }
  }
  if (step === 'store') {
    const shape = onboardingSchema.pick({
      code: true,
      name: true,
      default_currency: true,
      default_locale: true,
      default_country: true,
      timezone: true,
      currencies: true,
      locales: true,
    });
    const parsed = shape.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems[String(issue.path[0])] ??= issue.message;
    }
    if (parseSettings(values.settings_json) === null)
      problems['settings_json'] = 'Settings must be a JSON object';
  }
  if (step === 'domain') {
    if (!onboardingSchema.shape.hostname.safeParse(values.hostname).success)
      problems['hostname'] = 'A hostname like shop.brand-c.com — no scheme, no path';
  }
  return problems;
}

/** `{}` for an empty box, the object for a JSON object, null for anything else. */
export function parseSettings(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type OnboardingInput = AdminComponents['StoreOnboardingInput'];

/** The request body: exactly one of `legal_entity_id` / `legal_entity`; the defaults first. */
export function toOnboardingInput(values: OnboardingValues): OnboardingInput {
  const unique = (list: string[], first: string) => [
    ...new Set([first, ...list.filter((v) => v !== '')]),
  ];
  const settings = parseSettings(values.settings_json) ?? {};
  const le = values.legal_entity;
  return {
    ...(values.legal_entity_mode === 'existing'
      ? { legal_entity_id: values.legal_entity_id }
      : {
          legal_entity: {
            code: le.code,
            name: le.name.trim(),
            country: le.country,
            currency: le.currency,
            vat_number: le.vat_number.trim() === '' ? null : le.vat_number.trim(),
          },
        }),
    code: values.code,
    name: values.name.trim(),
    default_currency: values.default_currency,
    default_locale: values.default_locale,
    default_country: values.default_country,
    timezone: values.timezone,
    currencies: unique(values.currencies, values.default_currency),
    locales: unique(values.locales, values.default_locale),
    domain: { hostname: values.hostname.trim().toLowerCase() },
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
  };
}
