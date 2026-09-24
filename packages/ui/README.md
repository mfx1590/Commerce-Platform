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

`Store.theme` is documented in the contract as exactly this `BrandTokens` shape (CONTRACT CHANGE #41,
accepted 2026-09-05), and the examples and seed use the singular group names. `parseTheme` also
accepts the plural spellings (`colors`, `fonts`, `radii`, `shadows`, …) as tolerance for stores
seeded before that change; the manager's ruling is to keep the aliases through Phase 1.

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

## Image loader (Cloudinary)

`@platform/ui/image-loader` exports `cloudinaryImageLoader`, `transformUrl` and `isCloudinaryUrl`
(REQUEST #169). A Cloudinary delivery URL gets `c_limit,w_<width>,q_<quality|auto>,f_auto` inserted
after `/upload/`, chained **before** any transformation already stored with the asset; any other URL
is returned unchanged. No cloud name is baked in — it comes from the URL, so one function serves
every brand.

```ts
import { cloudinaryImageLoader, isCloudinaryUrl } from '@platform/ui/image-loader';
```

Import it from the **subpath**, not the root. The same functions are exported from `@platform/ui`,
but the kit declares no `sideEffects`, so a bundler reaching them through the barrel pulls in far
more: 1.5 kB of first-load JS per image route in the storefront, against 0.2 kB through the subpath.

Do not wire it as a Next.js `images.loaderFile`: that switches the app to `loader: 'custom'`, which
disables `/_next/image` entirely, so every non-Cloudinary image 404s. Choose the loader per image in
a client component instead — the storefront's `ProductImage` shows how.

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
