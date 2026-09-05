import type { CSSProperties, ElementType, ReactNode } from 'react';
import { cn } from './lib/cn.js';
import {
  type BrandTokens,
  defaultTokens,
  mergeTokens,
  parseTheme,
  tokensToCssVars,
} from './tokens.js';

export interface ThemeProviderProps {
  /** Already-narrowed brand overrides (e.g. from `src/brand/tokens.ts`). Wins over `theme`. */
  tokens?: BrandTokens;
  /** Raw `store.theme` from the Store API — free-form JSON, narrowed with `parseTheme`. */
  theme?: unknown;
  /** Element to render. Default `div`; a root layout may pass `'body'`. */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * Applies design tokens as CSS custom properties on a wrapper element, so a brand overrides the
 * look at runtime (values come from the API) without a rebuild. Deliberately free of hooks and
 * context: it renders unchanged inside a React Server Component.
 */
export function ThemeProvider({
  tokens,
  theme,
  as,
  className,
  style,
  children,
}: ThemeProviderProps) {
  const Component = as ?? 'div';
  // Layered per group, so `tokens` can override a single key of a theme group without erasing it.
  const vars = tokensToCssVars(mergeTokens(mergeTokens(defaultTokens, parseTheme(theme)), tokens));

  return (
    <Component
      data-ui-theme=""
      className={cn(className)}
      style={
        {
          ...vars,
          fontFamily: 'var(--ui-font-sans)',
          color: 'var(--ui-color-foreground)',
          ...style,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
}
