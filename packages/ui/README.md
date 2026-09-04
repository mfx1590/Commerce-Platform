# @platform/ui

Shared storefront UI kit: design tokens, a `ThemeProvider` that applies a brand override, and
primitives built on Tailwind + shadcn/ui conventions. Brands override tokens, not components.

Framework-agnostic React — no Next.js imports — so the starter, brand apps and any preview tool can
all consume it. Owner: window 3 (storefront). Run/test commands and the full public API are in
[CLAUDE.md](./CLAUDE.md).

## Tokens are CSS variables

`defaultTokens` (colors, typography scale, spacing, radius, shadows) are flattened to CSS custom
properties named `--ui-<group>-<name>` (`--ui-color-primary-foreground`, `--ui-font-size-2xl`,
`--ui-radius-md`). `ThemeProvider` writes them as inline styles on its wrapper element, so a brand
changes its look **at runtime** from API data — no rebuild, no per-brand CSS bundle.

```tsx
import { ThemeProvider } from '@platform/ui';

// `store.theme` comes from GET /store and is free-form JSON in the contract.
export default function Layout({ store, children }) {
  return (
    <ThemeProvider theme={store.theme} tokens={brandTokens}>
      {children}
    </ThemeProvider>
  );
}
```

`theme` is narrowed by `parseTheme`: unknown groups, unknown keys and non-string values are dropped,
so a bad theme from the API can never break the layout or smuggle CSS into the page. `tokens` (a
typed `BrandTokens` from the brand's own `src/brand/tokens.ts`) is layered on top, per key.

`ThemeProvider` uses no hooks and no context, so it renders unchanged inside a React Server
Component. Client components read token values through the CSS variables, never from a context.

## Tailwind preset

`@platform/ui/preset` maps utility class names onto those variables — `bg-primary`, `text-muted-foreground`,
`rounded-md`, `shadow-lg`, `text-2xl` — so component classes never change when a brand does:

```js
// apps/<app>/tailwind.config.ts
import { tailwindPreset } from '@platform/ui/preset';

export default {
  presets: [tailwindPreset],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/dist/**/*.js'],
};
```

Colors resolve to plain `var(--ui-color-*)` values, so Tailwind's `/opacity` modifier does not apply
to them — use a token (e.g. `muted`) instead of `primary/50`.

## Primitives

`Button`, `Input`, `Select`, `Card` (+ `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`),
`Dialog` (+ `DialogFooter`), `Badge`, `Price`, `Skeleton`.

- Every primitive is keyboard-operable; `Dialog` traps Tab/Shift+Tab, closes on Escape and returns
  focus to the trigger. `Select` is a styled native `<select>` on purpose.
- `Price` renders `{ amount_minor, currency }` with `Intl.NumberFormat`, honouring each currency's
  minor-unit exponent (2 for EUR, 0 for JPY), and strikes through a higher `compareAt`. It takes an
  explicit `locale` prop and stays server-renderable.
- `Dialog` is the only `'use client'` module in the package.

## Test

```bash
pnpm --filter @platform/ui test
```
