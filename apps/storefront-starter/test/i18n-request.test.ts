import { describe, expect, it } from 'vitest';
import { catalogueFor } from '@/i18n/catalogue';

/**
 * #441 part 5: a configured locale with no `messages/<locale>.json` fails loudly, naming the file —
 * not a bare `Cannot find module './en-US.json'` from deep inside `next build` (brand C, measured).
 */
describe('catalogueFor', () => {
  it('returns the catalogue the loader finds', async () => {
    const messages = await catalogueFor('en-GB', async () => ({
      default: { nav: { shop: 'Shop' } },
    }));
    expect(messages).toEqual({ nav: { shop: 'Shop' } });
  });

  it('names the missing catalogue and the variable that asked for it', async () => {
    await expect(
      catalogueFor('en-US', async () => {
        throw new Error("Cannot find module './en-US.json'");
      }),
    ).rejects.toThrow(
      /No message catalogue for locale "en-US": add messages\/en-US\.json or remove en-US from SUPPORTED_LOCALES/,
    );
  });

  it('loads the starter’s real catalogues', async () => {
    const english = await catalogueFor('en-GB');
    expect(english).toHaveProperty('common');
  });
});
