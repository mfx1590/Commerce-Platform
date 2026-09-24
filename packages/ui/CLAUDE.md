# @platform/ui

## Purpose

Shared storefront UI kit: theme tokens, a `ThemeProvider` applying brand overrides, and primitives
built on Tailwind + shadcn/ui conventions. Brands override tokens, not components.
Framework-agnostic React: no Next.js imports.

## Owner

window 3 (storefront).

## Run / test

- `pnpm --filter @platform/ui build` — compile to dist/
- `pnpm --filter @platform/ui typecheck` — src and test
- `pnpm --filter @platform/ui test` — Vitest + Testing Library on jsdom (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/ui` before finishing any task.

## Public API

`import { … } from '@platform/ui'`:

- Tokens: `defaultTokens`, `mergeTokens`, `tokensToCssVars`, `parseTheme`, `cssVarName`, types
  `Tokens`, `BrandTokens`, `ColorTokens`, `FontTokens`, `FontSizeTokens`, `FontWeightTokens`,
  `LineHeightTokens`, `SpacingTokens`, `RadiusTokens`, `ShadowTokens`
- Theme: `ThemeProvider`, `ThemeProviderProps`
- Primitives: `Button` (`buttonVariants`, `ButtonProps`, `ButtonVariants`), `Input` (`InputProps`),
  `Select` (`SelectProps`), `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`,
  `CardFooter` (`CardProps`), `Dialog`, `DialogFooter` (`DialogProps`), `Badge` (`badgeVariants`,
  `BadgeProps`, `BadgeVariants`), `Price` (`PriceProps`, `Money`, `formatMoney`, `minorUnitDigits`,
  `DEFAULT_LOCALE`), `Skeleton`
- Helpers: `cn`, `variants` (`VariantMap`, `VariantProps`), `PACKAGE_NAME`
- Image loader: `cloudinaryImageLoader`, `transformUrl`, `isCloudinaryUrl`, `CloudinaryLoaderParams`
  (also the subpath below — prefer it)

`import { tailwindPreset } from '@platform/ui/preset'` — Tailwind preset mapping utility classes
onto the `--ui-*` variables. Also the default export of that entry point.

`import { cloudinaryImageLoader, isCloudinaryUrl } from '@platform/ui/image-loader'` — the
`next/image` loader for Cloudinary delivery URLs, on its own entry point so it costs ~0.2 kB of
first-load JS instead of pulling the barrel in. Never as `images.loaderFile` (see README).

Tokens contract: `packages/ui/src/tokens.ts` — one `BrandTokens` object per brand overriding
`defaultTokens`; the same shape is what the Store API returns in `Store.theme`.

## Conventions

- `ThemeProvider` stays hook- and context-free so it works in a React Server Component. Only modules
  that need state carry `'use client'` (today: `components/dialog.tsx`).
- Components read tokens through Tailwind classes / CSS variables, never by importing token objects.
- Variant classes go through `variants()` in `src/lib/variants.ts` (a `cva` stand-in, no dependency);
  merge caller classes with `cn()` so a caller can override a base utility.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.
