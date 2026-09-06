/**
 * Tiny `cva` stand-in: maps variant props to class names without adding a dependency.
 * A group missing from `props` falls back to `defaults`.
 */
export type VariantMap = Record<string, Record<string, string>>;

export type VariantProps<M extends VariantMap> = {
  [G in keyof M]?: (keyof M[G] & string) | undefined;
};

export function variants<M extends VariantMap>(config: {
  base: string;
  variants: M;
  defaults: { [G in keyof M]: keyof M[G] & string };
}): (props?: VariantProps<M>) => string {
  return (props) => {
    const classes: string[] = [config.base];
    for (const group of Object.keys(config.variants) as (keyof M)[]) {
      const chosen = props?.[group] ?? config.defaults[group];
      const value = config.variants[group]?.[chosen];
      if (value) classes.push(value);
    }
    return classes.join(' ');
  };
}
