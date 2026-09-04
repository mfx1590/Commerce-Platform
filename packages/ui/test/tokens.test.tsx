import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ThemeProvider,
  cssVarName,
  defaultTokens,
  mergeTokens,
  parseTheme,
  tokensToCssVars,
} from '../src/index.js';

describe('cssVarName', () => {
  it('kebab-cases group and token names', () => {
    expect(cssVarName('color', 'primaryForeground')).toBe('--ui-color-primary-foreground');
    expect(cssVarName('fontSize', '2xl')).toBe('--ui-font-size-2xl');
    expect(cssVarName('spacing', '4')).toBe('--ui-spacing-4');
  });
});

describe('mergeTokens', () => {
  it('overrides only the given keys and keeps the rest', () => {
    const merged = mergeTokens(defaultTokens, { color: { primary: '#ff0000' } });
    expect(merged.color.primary).toBe('#ff0000');
    expect(merged.color.primaryForeground).toBe(defaultTokens.color.primaryForeground);
    expect(merged.radius).toEqual(defaultTokens.radius);
  });

  it('returns the base unchanged when there is no override', () => {
    expect(mergeTokens(defaultTokens)).toBe(defaultTokens);
  });
});

describe('tokensToCssVars', () => {
  it('flattens every group to --ui-* custom properties', () => {
    const vars = tokensToCssVars(defaultTokens);
    expect(vars['--ui-color-primary']).toBe(defaultTokens.color.primary);
    expect(vars['--ui-radius-md']).toBe(defaultTokens.radius.md);
    expect(vars['--ui-shadow-lg']).toBe(defaultTokens.shadow.lg);
  });
});

describe('parseTheme', () => {
  it('keeps known string tokens', () => {
    expect(parseTheme({ color: { primary: '#123456' }, radius: { md: '2px' } })).toEqual({
      color: { primary: '#123456' },
      radius: { md: '2px' },
    });
  });

  it('drops unknown groups, unknown keys and non-string values', () => {
    expect(
      parseTheme({
        color: { primary: '#123456', notAToken: 'x', background: 42 },
        somethingElse: { a: 'b' },
      }),
    ).toEqual({ color: { primary: '#123456' } });
  });

  it('survives rubbish from the API', () => {
    expect(parseTheme(null)).toEqual({});
    expect(parseTheme('a string')).toEqual({});
    expect(parseTheme(undefined)).toEqual({});
  });
});

describe('ThemeProvider', () => {
  it('writes every token as a CSS variable on the wrapper', () => {
    render(
      <ThemeProvider>
        <span>content</span>
      </ThemeProvider>,
    );
    const root = screen.getByText('content').parentElement;
    expect(root?.style.getPropertyValue('--ui-color-primary')).toBe(defaultTokens.color.primary);
    expect(root?.style.getPropertyValue('--ui-font-size-base')).toBe(defaultTokens.fontSize.base);
  });

  it('applies a raw store.theme and lets explicit tokens win', () => {
    render(
      <ThemeProvider theme={{ color: { primary: '#ff0000', background: '#eeeeee' } }}>
        <span>content</span>
      </ThemeProvider>,
    );
    const root = screen.getByText('content').parentElement;
    expect(root?.style.getPropertyValue('--ui-color-primary')).toBe('#ff0000');
    expect(root?.style.getPropertyValue('--ui-color-background')).toBe('#eeeeee');
  });

  it('gives tokens precedence over the raw theme', () => {
    render(
      <ThemeProvider
        theme={{ color: { primary: '#ff0000' } }}
        tokens={{ color: { primary: '#00ff00' } }}
      >
        <span>content</span>
      </ThemeProvider>,
    );
    const root = screen.getByText('content').parentElement;
    expect(root?.style.getPropertyValue('--ui-color-primary')).toBe('#00ff00');
  });
});
