import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TYPES,
  FIXTURE_LOCALE,
  campaignLandingFixture,
  documentId,
  fixtureDocuments,
  fixtures,
  pageFixture,
  schemaTypes,
  uniqueLocaleSlug,
  validateDocument,
} from '../src/index.js';
import type { CmsDocument, ValidationClient } from '../src/index.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fakeClient(existingId: string | null): () => ValidationClient {
  return () => ({ fetch: async () => existingId as never });
}

describe('fixtures', () => {
  it('cover every document type exactly once', () => {
    expect(Object.keys(fixtures).sort()).toEqual([...DOCUMENT_TYPES].sort());
    for (const type of DOCUMENT_TYPES) expect(fixtures[type]._type).toBe(type);
  });

  it.each(fixtureDocuments.map((doc) => [doc._type, doc] as const))(
    '%s validates against its schema',
    async (_type, doc) => {
      const errors = await validateDocument(doc as unknown as Record<string, unknown>, schemaTypes);
      expect(errors).toEqual([]);
    },
  );

  it('use deterministic ids of the form <type>.<locale>.<slug>', () => {
    expect(pageFixture._id).toBe(documentId('page', FIXTURE_LOCALE, 'about'));
    expect(pageFixture._id).toBe('page.en-GB.about');
    for (const doc of fixtureDocuments) {
      expect(doc._id.startsWith(`${doc._type}.${doc.locale}.`), doc._id).toBe(true);
      expect(doc.locale).toBe(FIXTURE_LOCALE);
    }
  });
});

describe('validateDocument', () => {
  const validate = (doc: CmsDocument) =>
    validateDocument(doc as unknown as Record<string, unknown>, schemaTypes);

  it('reports a missing required field at its path', async () => {
    const doc = clone(pageFixture) as unknown as Record<string, unknown>;
    delete doc['title'];
    const errors = await validateDocument(doc, schemaTypes);
    expect(errors).toEqual([{ path: 'title', message: 'Required' }]);
  });

  it('rejects an image without alt text, wherever it sits', async () => {
    const doc = clone(pageFixture);
    (doc.hero!.image as { alt?: string }).alt = '';
    const block = doc.blocks![1] as { image: { alt?: string } };
    delete block.image.alt;
    const errors = await validate(doc);
    expect(errors.map((e) => e.path).sort()).toEqual(['blocks[1].image.alt', 'hero.image.alt']);
  });

  it('rejects a product handle that is not kebab-case', async () => {
    const doc = clone(pageFixture);
    (doc.blocks![2] as { productHandle: string }).productHandle = 'Alpine Backpack';
    const errors = await validate(doc);
    expect(errors).toEqual([
      { path: 'blocks[2].productHandle', message: 'Must match kebab-case product handle' },
    ]);
  });

  it('rejects links that are neither storefront paths nor http(s) URLs', async () => {
    const doc = clone(pageFixture);
    doc.hero!.ctas![0]!.href = 'javascript:alert(1)';
    doc.blocks![3] = {
      _type: 'cta',
      _key: 'x',
      label: 'Go',
      href: 'mailto:x@y.z',
      variant: 'primary',
    };
    const errors = await validate(doc);
    expect(errors.map((e) => e.path).sort()).toEqual(['blocks[3].href', 'hero.ctas[0].href']);
  });

  it('enforces max lengths and array bounds', async () => {
    const doc = clone(pageFixture);
    doc.seo!.metaTitle = 'x'.repeat(71);
    doc.hero!.ctas = [1, 2, 3].map((n) => ({
      _type: 'cta',
      _key: String(n),
      label: 'A',
      href: '/',
      variant: 'primary',
    }));
    const errors = await validate(doc);
    expect(errors.map((e) => e.path).sort()).toEqual(['hero.ctas', 'seo.metaTitle']);
  });

  it('rejects a locale that is not xx-YY and an unknown document type', async () => {
    const doc = clone(pageFixture) as unknown as Record<string, unknown>;
    doc['locale'] = 'english';
    expect(await validateDocument(doc, schemaTypes)).toEqual([
      { path: 'locale', message: 'Must match BCP-47 locale (xx-YY)' },
    ]);
    expect(await validateDocument({ _type: 'nope' }, schemaTypes)).toEqual([
      { path: '_type', message: 'Unknown document type nope' },
    ]);
  });

  it('requires a campaign landing to end after it starts and to have a hero', async () => {
    const doc = clone(campaignLandingFixture);
    doc.endsAt = '2026-02-01T00:00:00.000Z';
    delete (doc as { hero?: unknown }).hero;
    const errors = await validate(doc);
    expect(errors).toEqual([
      { path: 'hero', message: 'Required' },
      { path: 'endsAt', message: 'Must end after it starts' },
    ]);
  });

  it('runs the (locale, slug) uniqueness check only when a client is available', async () => {
    const doc = pageFixture as unknown as Record<string, unknown>;
    expect(await validateDocument(doc, schemaTypes)).toEqual([]);
    expect(await validateDocument(doc, schemaTypes, { getClient: fakeClient(null) })).toEqual([]);
    expect(
      await validateDocument(doc, schemaTypes, { getClient: fakeClient('page.en-GB.about-2') }),
    ).toEqual([{ path: 'slug', message: 'Another page already uses /en-GB/about' }]);
  });

  it('uniqueness query excludes the document itself and its draft', async () => {
    let params: Record<string, unknown> | undefined;
    const client: ValidationClient = {
      fetch: async (_query, p) => {
        params = p;
        return null as never;
      },
    };
    await uniqueLocaleSlug(pageFixture.slug, {
      document: { ...pageFixture, _id: 'drafts.page.en-GB.about' },
      getClient: () => client,
    });
    expect(params).toMatchObject({
      type: 'page',
      locale: 'en-GB',
      own: 'about',
      id: 'page.en-GB.about',
      draftId: 'drafts.page.en-GB.about',
    });
  });
});
