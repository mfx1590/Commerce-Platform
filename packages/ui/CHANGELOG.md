# Changelog — @platform/ui

## 0.2.0 — 2026-09-04

Task [storefront] 1.1 (issue #17), contracts `contracts-v0.1`.

- `defaultTokens`: colors, typography scale, spacing, radius, shadows — flattened to
  `--ui-<group>-<name>` CSS custom properties (`cssVarName`, `tokensToCssVars`, `mergeTokens`).
- `ThemeProvider`: applies a brand override at runtime; hook- and context-free, so it renders inside
  a React Server Component. `parseTheme` narrows the free-form `store.theme` from the Store API.
- Primitives: `Button`, `Input`, `Select`, `Card` family, `Dialog` (focus trap) + `DialogFooter`,
  `Badge`, `Price` (+ `formatMoney`, `minorUnitDigits`), `Skeleton`, plus `cn` and `variants`.
- `@platform/ui/preset`: Tailwind preset mapping utilities onto the token variables.
- 35 tests (Vitest + Testing Library, jsdom): `Price` formatting per locale/currency, `Dialog` focus
  trap and Escape handling, keyboard operability of every primitive, theme narrowing.
- Dependencies added: `clsx`, `tailwind-merge`; React 19 as a peer dependency.

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
