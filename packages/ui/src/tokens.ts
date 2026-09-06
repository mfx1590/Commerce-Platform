/**
 * Design tokens for @platform/ui.
 *
 * Every token becomes a CSS custom property (`--ui-<group>-<name>`) so a brand can override the
 * look at runtime — the value comes from `store.theme` in the Store API, no rebuild involved.
 * Components never read token objects directly; they use the Tailwind class names that the
 * preset (`@platform/ui/preset`) maps onto those variables.
 */

export interface ColorTokens {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  card: string;
  cardForeground: string;
  border: string;
  input: string;
  ring: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  success: string;
  successForeground: string;
}

export interface FontTokens {
  sans: string;
  serif: string;
  mono: string;
}

export interface FontSizeTokens {
  xs: string;
  sm: string;
  base: string;
  lg: string;
  xl: string;
  '2xl': string;
  '3xl': string;
  '4xl': string;
}

export interface FontWeightTokens {
  normal: string;
  medium: string;
  semibold: string;
  bold: string;
}

export interface LineHeightTokens {
  tight: string;
  normal: string;
  relaxed: string;
}

export interface SpacingTokens {
  '0': string;
  '1': string;
  '2': string;
  '3': string;
  '4': string;
  '5': string;
  '6': string;
  '8': string;
  '10': string;
  '12': string;
  '16': string;
  '20': string;
  '24': string;
}

export interface RadiusTokens {
  none: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  full: string;
}

export interface ShadowTokens {
  sm: string;
  md: string;
  lg: string;
  xl: string;
}

export interface Tokens {
  color: ColorTokens;
  font: FontTokens;
  fontSize: FontSizeTokens;
  fontWeight: FontWeightTokens;
  lineHeight: LineHeightTokens;
  spacing: SpacingTokens;
  radius: RadiusTokens;
  shadow: ShadowTokens;
}

/** A brand override: any subset of the default tokens. This is the shape stored in `store.theme`. */
export type BrandTokens = { [G in keyof Tokens]?: Partial<Tokens[G]> };

export const defaultTokens: Tokens = {
  color: {
    background: '#ffffff',
    foreground: '#0b0d12',
    muted: '#f4f5f7',
    mutedForeground: '#5b6472',
    card: '#ffffff',
    cardForeground: '#0b0d12',
    border: '#e3e6ea',
    input: '#e3e6ea',
    ring: '#0b0d12',
    primary: '#0b0d12',
    primaryForeground: '#ffffff',
    secondary: '#f4f5f7',
    secondaryForeground: '#0b0d12',
    accent: '#f4f5f7',
    accentForeground: '#0b0d12',
    destructive: '#b42318',
    destructiveForeground: '#ffffff',
    success: '#067647',
    successForeground: '#ffffff',
  },
  font: {
    sans: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
    serif: 'ui-serif, Georgia, Cambria, Times New Roman, serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
    '4xl': '2.25rem',
  },
  fontWeight: { normal: '400', medium: '500', semibold: '600', bold: '700' },
  lineHeight: { tight: '1.2', normal: '1.5', relaxed: '1.75' },
  spacing: {
    '0': '0px',
    '1': '0.25rem',
    '2': '0.5rem',
    '3': '0.75rem',
    '4': '1rem',
    '5': '1.25rem',
    '6': '1.5rem',
    '8': '2rem',
    '10': '2.5rem',
    '12': '3rem',
    '16': '4rem',
    '20': '5rem',
    '24': '6rem',
  },
  radius: {
    none: '0px',
    sm: '0.25rem',
    md: '0.5rem',
    lg: '0.75rem',
    xl: '1rem',
    full: '9999px',
  },
  shadow: {
    sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  },
};

const TOKEN_GROUPS = Object.keys(defaultTokens) as (keyof Tokens)[];

/** `fontSize` -> `font-size`, `primaryForeground` -> `primary-foreground`, `2xl` stays `2xl`. */
function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** CSS custom property name for one token, e.g. `--ui-color-primary-foreground`. */
export function cssVarName(group: keyof Tokens, name: string): string {
  return `--ui-${kebab(group)}-${kebab(name)}`;
}

/** Merge a brand override on top of the defaults. Unknown groups/keys are dropped by `parseTheme`. */
export function mergeTokens(base: Tokens, override?: BrandTokens): Tokens {
  if (!override) return base;
  const merged = {} as Tokens;
  for (const group of TOKEN_GROUPS) {
    Object.assign(merged, { [group]: { ...base[group], ...(override[group] ?? {}) } });
  }
  return merged;
}

/** Flatten tokens to the CSS custom properties the Tailwind preset reads. */
export function tokensToCssVars(tokens: BrandTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const group of TOKEN_GROUPS) {
    const values = tokens[group];
    if (!values) continue;
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string') vars[cssVarName(group, name)] = value;
    }
  }
  return vars;
}

/**
 * Plural spellings a store theme may use for a token group. `Store.theme` is free-form JSON in the
 * contract (the seeded Brand A theme writes `colors`), so the kit accepts both rather than silently
 * dropping a brand's colours.
 */
const GROUP_ALIASES: Readonly<Record<string, keyof Tokens>> = {
  colors: 'color',
  fonts: 'font',
  fontSizes: 'fontSize',
  fontWeights: 'fontWeight',
  lineHeights: 'lineHeight',
  radii: 'radius',
  shadows: 'shadow',
};

function canonicalGroup(name: string): keyof Tokens | undefined {
  if (Object.prototype.hasOwnProperty.call(defaultTokens, name)) return name as keyof Tokens;
  return GROUP_ALIASES[name];
}

function pickTokens(group: keyof Tokens, candidate: unknown): Record<string, string> {
  if (typeof candidate !== 'object' || candidate === null) return {};
  const allowed = defaultTokens[group] as unknown as Record<string, string>;
  const picked: Record<string, string> = {};
  for (const [name, tokenValue] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof tokenValue !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(allowed, name)) continue;
    picked[name] = tokenValue;
  }
  return picked;
}

/**
 * Narrow arbitrary JSON (`store.theme`, which the Store API types as free-form) to BrandTokens.
 * Unknown groups, unknown keys and non-string values are dropped, so a bad theme from the API can
 * never break the layout or smuggle CSS into the page.
 */
export function parseTheme(value: unknown): BrandTokens {
  if (typeof value !== 'object' || value === null) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  const result: BrandTokens = {};

  // Aliases first, then canonical names, so `color` wins over `colors` if a theme sends both.
  const ordered = [
    ...entries.filter(([name]) => !Object.prototype.hasOwnProperty.call(defaultTokens, name)),
    ...entries.filter(([name]) => Object.prototype.hasOwnProperty.call(defaultTokens, name)),
  ];

  for (const [rawGroup, candidate] of ordered) {
    const group = canonicalGroup(rawGroup);
    if (!group) continue;
    const picked = { ...(result[group] ?? {}), ...pickTokens(group, candidate) };
    if (Object.keys(picked).length > 0) Object.assign(result, { [group]: picked });
  }
  return result;
}
