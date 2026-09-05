/**
 * Tailwind preset: maps utility class names onto the CSS custom properties that `ThemeProvider`
 * writes. A brand changes colours by changing `store.theme` — the classes never change, and no
 * rebuild is needed. Consume it from an app's tailwind config:
 *
 *   import { tailwindPreset } from '@platform/ui/preset';
 *   export default { presets: [tailwindPreset], content: [..., '../../packages/ui/dist/**\/*.js'] };
 *
 * Colours are plain `var(--ui-color-*)` values, so Tailwind's `/opacity` modifier does not apply
 * to them; use a token (e.g. `muted`) instead of `primary/50`.
 */

const color = (name: string) => `var(--ui-color-${name})`;

export const tailwindPreset = {
  theme: {
    extend: {
      colors: {
        background: color('background'),
        foreground: color('foreground'),
        muted: color('muted'),
        'muted-foreground': color('muted-foreground'),
        card: color('card'),
        'card-foreground': color('card-foreground'),
        border: color('border'),
        input: color('input'),
        ring: color('ring'),
        primary: color('primary'),
        'primary-foreground': color('primary-foreground'),
        secondary: color('secondary'),
        'secondary-foreground': color('secondary-foreground'),
        accent: color('accent'),
        'accent-foreground': color('accent-foreground'),
        destructive: color('destructive'),
        'destructive-foreground': color('destructive-foreground'),
        success: color('success'),
        'success-foreground': color('success-foreground'),
      },
      fontFamily: {
        sans: 'var(--ui-font-sans)',
        serif: 'var(--ui-font-serif)',
        mono: 'var(--ui-font-mono)',
      },
      fontSize: {
        xs: 'var(--ui-font-size-xs)',
        sm: 'var(--ui-font-size-sm)',
        base: 'var(--ui-font-size-base)',
        lg: 'var(--ui-font-size-lg)',
        xl: 'var(--ui-font-size-xl)',
        '2xl': 'var(--ui-font-size-2xl)',
        '3xl': 'var(--ui-font-size-3xl)',
        '4xl': 'var(--ui-font-size-4xl)',
      },
      fontWeight: {
        normal: 'var(--ui-font-weight-normal)',
        medium: 'var(--ui-font-weight-medium)',
        semibold: 'var(--ui-font-weight-semibold)',
        bold: 'var(--ui-font-weight-bold)',
      },
      lineHeight: {
        tight: 'var(--ui-line-height-tight)',
        normal: 'var(--ui-line-height-normal)',
        relaxed: 'var(--ui-line-height-relaxed)',
      },
      borderRadius: {
        none: 'var(--ui-radius-none)',
        sm: 'var(--ui-radius-sm)',
        md: 'var(--ui-radius-md)',
        lg: 'var(--ui-radius-lg)',
        xl: 'var(--ui-radius-xl)',
        full: 'var(--ui-radius-full)',
      },
      boxShadow: {
        sm: 'var(--ui-shadow-sm)',
        md: 'var(--ui-shadow-md)',
        lg: 'var(--ui-shadow-lg)',
        xl: 'var(--ui-shadow-xl)',
      },
    },
  },
} as const;

export default tailwindPreset;
