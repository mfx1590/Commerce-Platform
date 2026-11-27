/**
 * The `store.settings` paths this app edits, and the read-modify-write they need (#870 item 7).
 *
 * **Why a path catalogue exists at all.** `Store.settings` is `additionalProperties: true` in the
 * contract: the authoritative list of what the core reads is `STORE_SETTINGS_SHAPES` in
 * `apps/core/src/modules/registry/settings-schema.ts`, and the 422 it throws names each offending
 * path in `details.settings`. So the admin mirrors that list here, and
 * `test/store-settings-drift.test.ts` reads the core's file as text and fails if the two disagree —
 * including when the core gains a path this app has not decided about. CONTRACT CHANGE #967 asks
 * for the paths to be described in the yaml; when it lands, the guard reads the yaml instead.
 *
 * **Why every save is a read-modify-write.** `updateStore` REPLACES the whole settings column
 * (`settings = $n` in `updateStoreInTx`) — not a shallow merge, a wholesale one. A card that sent
 * only its own group would delete every other module's keys. So `withPaths` deep-sets a card's
 * paths into the settings **as the core has them now**, and the caller re-reads immediately before
 * writing. Established by `src/lib/settings/payment.ts` (#825); this is the general form.
 *
 * Pure: no `next/*`, no React, no I/O.
 */

export type SettingKind = 'boolean' | 'integer' | 'enum' | 'text' | 'enumArray';

export interface SettingField {
  /** Dotted path inside `store.settings`, exactly as the core reads it. */
  path: string;
  label: string;
  kind: SettingKind;
  hint?: string;
  /** `enum` / `enumArray`: the only values the core accepts. */
  options?: readonly string[];
  /** `integer`: inclusive bounds the core enforces. */
  min?: number;
  /** `text`: length bounds the core enforces. */
  minLength?: number;
  maxLength?: number;
  /**
   * An integer in the store currency's minor unit, so it is shown as a formatted amount rather
   * than a bare number — ¥1,980 is 1980, not 19.80 (zero-decimal currencies).
   */
  money?: boolean;
  /**
   * What the **core** does when this path is absent, in words (#968 review).
   *
   * An unset path is not "off" or "empty": `fraud.providers` absent means **both checks run**
   * (`DEFAULT_FRAUD_SETTINGS`), and an absent `support_refund_limit_minor` means no ceiling at all.
   * So an absent value is shown as "not set (default: …)" rather than as a value, and the form
   * never sends a field the reader did not touch. Traced from the reader in each owning module, not
   * guessed: `fraud/types.ts`, `tax/types.ts`, `payments/refund-router.ts`.
   */
  defaultLabel: string;
}

export type CardId = 'tax' | 'fraud' | 'refunds' | 'content';

export interface SettingsCard {
  id: CardId;
  title: string;
  description: string;
  /**
   * Something true about this card that the reader cannot see from the fields, shown under the
   * description. Today: which currency the refund limit is actually compared in (#968 review).
   */
  note?: string;
  fields: readonly SettingField[];
}

/**
 * Changing one of these is **confirmed against a diff** before it is sent.
 *
 * Money first (`support_refund_limit_minor` raises what support may hand back;
 * `tax.prices_include_tax` reinterprets every price in the store), and then — the manager's
 * decision — the fraud rules and the carrier accounts, because loosening a fraud rule or swapping
 * a carrier account is as consequential as a number with a currency on it.
 */
export const CONFIRM_PATHS: readonly string[] = [
  'support_refund_limit_minor',
  'tax.prices_include_tax',
  // #968 review: it changes what every order is taxed on, and its default is conditional on
  // the legal entity's country — so flipping it is never obviously right.
  'tax.shipping_taxable',
  'fraud.providers',
  'fraud.velocity.max_orders',
  'fraud.velocity.window_minutes',
  'fraud.country_mismatch',
  'fraud.radar_highest',
  'shipping.carrier_account_ids',
];

export const SETTINGS_CARDS: readonly SettingsCard[] = [
  {
    id: 'tax',
    title: 'Tax',
    description:
      'How tax is calculated and whether the prices in this store already contain it. Changing this needs store admin.',
    fields: [
      {
        path: 'tax.provider',
        defaultLabel: 'table — the tax rates of this store, offline',
        label: 'Calculated by',
        kind: 'enum',
        options: ['table', 'stripe'],
        hint: '`table` uses this store’s tax rates; `stripe` calls Stripe Tax.',
      },
      {
        path: 'tax.prices_include_tax',
        defaultLabel: 'off — prices are net and tax is added at checkout',
        label: 'Prices include tax',
        kind: 'boolean',
        hint: 'Off means every price is net and tax is added at checkout. Turning this on reinterprets every price in the store.',
      },
      {
        path: 'tax.shipping_taxable',
        defaultLabel: 'taxable when the legal entity is in the EU, otherwise not',
        label: 'Shipping is taxable',
        kind: 'boolean',
      },
    ],
  },
  {
    id: 'fraud',
    title: 'Fraud',
    description:
      'What is checked before a payment is authorised. Loosening a rule lets more orders through unchecked. Changing this needs store admin.',
    fields: [
      {
        path: 'fraud.providers',
        defaultLabel: 'BOTH checks run — rules and radar',
        label: 'Checks to run',
        kind: 'enumArray',
        options: ['rules', 'radar'],
        hint: '`rules` are the local checks below; `radar` is Stripe Radar. Unchecking both leaves this NOT SET, which means the core runs both — this card cannot switch fraud checking off, because doing that is not a checkbox.',
      },
      {
        path: 'fraud.velocity.max_orders',
        defaultLabel: '3',
        label: 'Orders allowed per window',
        kind: 'integer',
        min: 1,
      },
      {
        path: 'fraud.velocity.window_minutes',
        defaultLabel: '60',
        label: 'Window (minutes)',
        kind: 'integer',
        min: 1,
      },
      {
        path: 'fraud.country_mismatch',
        defaultLabel: 'review',
        label: 'Billing and shipping countries differ',
        kind: 'enum',
        options: ['review', 'allow'],
      },
      {
        path: 'fraud.radar_highest',
        defaultLabel: 'block — the payment is refused',
        label: 'Radar’s highest risk',
        kind: 'enum',
        options: ['block', 'review'],
        hint: '`block` refuses the payment; `review` places the order and flags it.',
      },
    ],
  },
  {
    id: 'refunds',
    title: 'Refunds',
    description:
      'The ceiling on what a support user may refund without a store admin. It does not limit a store admin. Changing this needs store admin.',
    note: 'Entered in this store’s default currency. The core compares it against the refund amount as a plain number, without converting: on an order in another currency it acts as that many minor units of THAT currency. Issue #969 asks for the comparison to carry a currency.',
    fields: [
      {
        path: 'support_refund_limit_minor',
        defaultLabel: 'no ceiling at all',
        label: 'Support refund limit',
        kind: 'integer',
        min: 0,
        money: true,
        hint: 'Per refund, not per order and not per day. Absent means support has no ceiling at all.',
      },
    ],
  },
  {
    id: 'content',
    title: 'Brand voice',
    description:
      'What the AI copy drafts are told about this brand. It is never shown to shoppers. Changing this needs store admin.',
    fields: [
      {
        path: 'content.brand_voice',
        defaultLabel: 'a neutral voice chosen by the drafting template',
        label: 'Brand voice',
        kind: 'text',
        minLength: 1,
        maxLength: 500,
      },
      {
        path: 'content.audience',
        defaultLabel: 'no audience given to the template',
        label: 'Audience',
        kind: 'text',
        minLength: 1,
        maxLength: 200,
      },
    ],
  },
];

/** Every path this app edits, flattened. */
export const EDITED_PATHS: readonly string[] = SETTINGS_CARDS.flatMap((card) =>
  card.fields.map((field) => field.path),
);

/**
 * Paths the core reads that this app deliberately does not edit **yet**, so the drift guard can
 * tell "not ours" from "new, and nobody has decided".
 *
 * `payment.methods` is DERIVED — the server computes it and refuses it when written — so it can
 * never be an input. `payment.invoice_allowed` has its own card already (#825). The `shipping.*`
 * and `fulfillment.*` groups arrive with PR B of this item; the bare group keys (`tax`, `fraud`, …)
 * are the core's own "this must be an object" checks, not fields.
 */
export const NOT_EDITED_PATHS: readonly string[] = [
  'payment',
  'payment.invoice_allowed',
  'payment.methods',
  'tax',
  'fraud',
  'fraud.velocity',
  'content',
  'shipping',
  'shipping.provider',
  'shipping.carrier_account_ids',
  'shipping.services',
  'shipping.default_parcel',
  'shipping.default_parcel.length_cm',
  'shipping.default_parcel.width_cm',
  'shipping.default_parcel.height_cm',
  'shipping.default_parcel.weight_g',
  'shipping.label_format',
  'fulfillment',
  'fulfillment.provider',
  'fulfillment.routing',
  'fulfillment.routing.default',
  'fulfillment.routing.countries',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at a dotted path, or `undefined` when any step is missing. */
export function valueAt(settings: unknown, path: string): unknown {
  let current: unknown = settings;
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * The full settings object to send: every key of `current` as it is, with these dotted paths
 * deep-set, and the derived `payment.methods` dropped wherever it came from.
 *
 * Intermediate objects are copied, never shared with `current`, so a caller cannot mutate the
 * store it read. A path whose value is `undefined` is **deleted** — that is how a field is cleared
 * (the core treats absent as "not set" and keeps its own default).
 */
export function withPaths(
  current: unknown,
  updates: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const root: Record<string, unknown> = isRecord(current) ? { ...current } : {};
  for (const [path, value] of Object.entries(updates)) {
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      node[part] = isRecord(next) ? { ...next } : {};
      node = node[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1]!;
    if (value === undefined) delete node[leaf];
    else node[leaf] = value;
  }
  // Derived by the server and refused when written, wherever it came from.
  if (isRecord(root['payment'])) {
    const payment = { ...(root['payment'] as Record<string, unknown>) };
    delete payment['methods'];
    root['payment'] = payment;
  }
  return root;
}

export interface SettingChange {
  path: string;
  label: string;
  from: string;
  to: string;
  /** Shown behind a confirmation step rather than saved straight away. */
  confirm: boolean;
}

/** How a value reads in a diff: never a bare `[object Object]`, never an empty string. */
export function describeValue(
  field: SettingField,
  value: unknown,
  money: (n: number) => string,
): string {
  if (value === undefined || value === null) return 'not set';
  if (field.money && typeof value === 'number') return money(value);
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.join(', ');
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value.trim() === '' ? 'empty' : value;
  if (typeof value === 'number') return String(value);
  return 'not shown';
}

/**
 * What a save would change, for the confirmation step. Only paths whose value actually differs
 * appear: a form that re-submits every field must not ask the reader to confirm a non-change.
 */
export function changesOf(
  fields: readonly SettingField[],
  current: unknown,
  updates: Readonly<Record<string, unknown>>,
  money: (n: number) => string,
): SettingChange[] {
  const changes: SettingChange[] = [];
  for (const field of fields) {
    if (!(field.path in updates)) continue;
    const before = valueAt(current, field.path);
    const after = updates[field.path];
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
    changes.push({
      path: field.path,
      label: field.label,
      from: describeValue(field, before, money),
      to: describeValue(field, after, money),
      confirm: CONFIRM_PATHS.includes(field.path),
    });
  }
  return changes;
}

/** True when a save needs the confirm step: any changed path is in `CONFIRM_PATHS`. */
export const needsConfirmation = (changes: readonly SettingChange[]): boolean =>
  changes.some((change) => change.confirm);

/** A card's current values by path, as the page read them out of `store.settings`. */
export type CardValues = Readonly<Record<string, unknown>>;

/** Only this card's paths, read off the store — what the form is given. */
/**
 * A card's values out of a store's settings.
 *
 * It lives HERE, in a pure module, and not next to the form, because the **server** component
 * builds the props with it. Exporting it from the `'use client'` form file type-checked, passed
 * every unit test (they import the function directly) and then threw
 * "Attempted to call cardValues() from the server" in a PRODUCTION build — taking the whole
 * settings page down, pre-existing cards included. `next dev` tolerated it; the e2e, which builds
 * for real, did not. Nothing that a server component calls belongs in a client module.
 */
export function cardValues(cardId: CardId, settings: unknown): CardValues {
  const card = SETTINGS_CARDS.find((candidate) => candidate.id === cardId)!;
  return Object.fromEntries(
    card.fields.map((field) => [field.path, valueAt(settings, field.path)]),
  );
}
