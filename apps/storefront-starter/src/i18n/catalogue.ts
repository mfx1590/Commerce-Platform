/**
 * The message catalogue for a locale (`messages/<locale>.json`), or a loud, named failure (#441
 * part 5).
 *
 * A locale in `SUPPORTED_LOCALES` with no catalogue is a configuration error, and it used to surface
 * as `Cannot find module './en-US.json'` from deep inside `next build` (brand C, measured), which
 * says nothing about the variable that caused it. Unlike the CMS catalogue (`request.ts`), this one
 * is not optional: a storefront with no UI strings cannot render a page.
 */
export type CatalogueLoader = (locale: string) => Promise<{ default: Record<string, unknown> }>;

const fromMessages: CatalogueLoader = (locale) => import(`../../messages/${locale}.json`);

export async function catalogueFor(
  locale: string,
  load: CatalogueLoader = fromMessages,
): Promise<Record<string, unknown>> {
  try {
    return (await load(locale)).default;
  } catch (cause) {
    throw new Error(
      `No message catalogue for locale "${locale}": add messages/${locale}.json or remove ` +
        `${locale} from SUPPORTED_LOCALES.`,
      { cause },
    );
  }
}
