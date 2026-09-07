# Changelog — @platform/ui

## 0.2.1 — 2026-09-04

Follow-up while wiring the starter (task [storefront] 1.2, issue #18).

- `parseTheme` accepts the plural group spellings a store theme may use (`colors`, `fonts`,
  `radii`, `shadows`, …) as aliases for the canonical groups, with the canonical name winning if a
  theme sends both. The seeded Brand A theme wrote `colors`, so its brand colour reached the page as
  the kit default before this. CONTRACT CHANGE #41 was accepted on 2026-09-05: `Store.theme` is now
  documented as the `BrandTokens` shape and the examples and seed use the singular names; the
  aliases stay as tolerance through Phase 1 (manager ruling).
- `exports` gained a `default` condition, so CJS-based resolvers (Tailwind loads
  `tailwind.config.ts` through jiti) can resolve `@platform/ui/preset`.

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
