// Public API of @platform/ui. Nothing outside this package may import from src/* directly.
// Framework-agnostic React: no Next.js imports, so brand apps and Storybook can both consume it.

export const PACKAGE_NAME = '@platform/ui' as const;

export { cn } from './lib/cn.js';
export { variants, type VariantMap, type VariantProps } from './lib/variants.js';

export {
  cssVarName,
  defaultTokens,
  mergeTokens,
  parseTheme,
  tokensToCssVars,
  type BrandTokens,
  type ColorTokens,
  type FontSizeTokens,
  type FontTokens,
  type FontWeightTokens,
  type LineHeightTokens,
  type RadiusTokens,
  type ShadowTokens,
  type SpacingTokens,
  type Tokens,
} from './tokens.js';

export { ThemeProvider, type ThemeProviderProps } from './theme.js';

export { Badge, badgeVariants, type BadgeProps, type BadgeVariants } from './components/badge.js';
export {
  Button,
  buttonVariants,
  type ButtonProps,
  type ButtonVariants,
} from './components/button.js';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardProps,
} from './components/card.js';
export { Dialog, DialogFooter, type DialogProps } from './components/dialog.js';
export { Input, type InputProps } from './components/input.js';
export {
  DEFAULT_LOCALE,
  Price,
  formatMoney,
  minorUnitDigits,
  type Money,
  type PriceProps,
} from './components/price.js';
export { Select, type SelectProps } from './components/select.js';
export { Skeleton } from './components/skeleton.js';
