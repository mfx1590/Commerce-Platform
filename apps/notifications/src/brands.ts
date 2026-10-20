// Brand profiles: who an email comes from and what its legal footer says (#360).
//
// One profile per store code, in code — the sender, the support address and the legal links are brand
// identity, not data a staff user edits in the admin. Values the owner only knows at go-live (the registered
// address, the real sender domain) are placeholders here and overridable per brand from the environment:
// `NOTIFICATIONS_<STORE_CODE>_<FIELD>` with the code upper-cased and `-` → `_`, e.g.
// `NOTIFICATIONS_BRAND_A_SENDER="Brand A <orders@brand-a.com>"`. The company name and VAT number come from
// the `legal_entity` row (`applyLegalEntity`), so they are never typed twice.
import type { BrandProfile, Sender } from './types.js';

const BRAND_A: BrandProfile = {
  storeCode: 'brand-a',
  name: 'Brand A',
  sender: { name: 'Brand A', email: 'orders@brand-a.example' },
  replyTo: null,
  supportEmail: 'support@brand-a.example',
  websiteUrl: 'https://brand-a.example',
  defaultLocale: 'en-GB',
  legal: {
    company: 'Brand A B.V.',
    address: '[registered address — set NOTIFICATIONS_BRAND_A_LEGAL_ADDRESS before go-live]',
    vatNumber: null,
    imprintUrl: 'https://brand-a.example/imprint',
    privacyUrl: 'https://brand-a.example/privacy',
  },
};

const PROFILES: Readonly<Record<string, BrandProfile>> = { 'brand-a': BRAND_A };

/** Store codes that have a profile — the default set a worker serves when `NOTIFICATIONS_STORE_CODES` is unset. */
export const BRAND_CODES: readonly string[] = Object.keys(PROFILES);

export type OverridableField =
  | 'SENDER'
  | 'REPLY_TO'
  | 'SUPPORT_EMAIL'
  | 'WEBSITE_URL'
  | 'LEGAL_ADDRESS'
  | 'IMPRINT_URL'
  | 'PRIVACY_URL';

export function envKeyFor(storeCode: string, field: OverridableField): string {
  return `NOTIFICATIONS_${storeCode.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${field}`;
}

/** `"Brand A <orders@brand-a.com>"` or a bare address. */
export function parseSender(value: string, fallbackName: string): Sender {
  const m = value.trim().match(/^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  if (m) return { name: (m[1] ?? '').replace(/^"|"$/g, '').trim() || fallbackName, email: m[2]! };
  const bare = value.trim();
  if (!/^[^<>\s]+@[^<>\s]+$/.test(bare)) throw new Error(`not a sender: "${value}"`);
  return { name: fallbackName, email: bare };
}

/** The profile for a store code with the environment's overrides applied, or null when no brand has one. */
export function brandProfile(
  storeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): BrandProfile | null {
  const base = PROFILES[storeCode];
  if (!base) return null;
  const read = (field: OverridableField): string | undefined => {
    const v = env[envKeyFor(storeCode, field)]?.trim();
    return v ? v : undefined;
  };
  const sender = read('SENDER');
  const replyTo = read('REPLY_TO');
  return {
    ...base,
    sender: sender ? parseSender(sender, base.name) : base.sender,
    replyTo: replyTo ?? base.replyTo,
    supportEmail: read('SUPPORT_EMAIL') ?? base.supportEmail,
    websiteUrl: read('WEBSITE_URL') ?? base.websiteUrl,
    legal: {
      ...base.legal,
      address: read('LEGAL_ADDRESS') ?? base.legal.address,
      imprintUrl: read('IMPRINT_URL') ?? base.legal.imprintUrl,
      privacyUrl: read('PRIVACY_URL') ?? base.legal.privacyUrl,
    },
  };
}

/** The legal entity behind the store is the database's word, not the profile's. */
export function applyLegalEntity(
  profile: BrandProfile,
  legalEntity: { name: string; vatNumber: string | null },
): BrandProfile {
  return {
    ...profile,
    legal: { ...profile.legal, company: legalEntity.name, vatNumber: legalEntity.vatNumber },
  };
}
