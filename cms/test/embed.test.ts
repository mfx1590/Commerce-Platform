import { describe, expect, it } from 'vitest';
import {
  EMBED_HEIGHT,
  EMBED_HTML_MAX_LENGTH,
  campaignLandingFixture,
  embedSource,
  isAllowedEmbedUrl,
  schemaTypes,
  validateDocument,
} from '../src/index.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('isAllowedEmbedUrl', () => {
  it('accepts https URLs on the provider allow-list, one subdomain label for wildcards', () => {
    expect(isAllowedEmbedUrl('builder', 'https://builder.io/x')).toBe(true);
    expect(isAllowedEmbedUrl('builder', 'https://cdn.builder.io/api/v1/html/x')).toBe(true);
    expect(isAllowedEmbedUrl('framer', 'https://spring-sale.framer.website/')).toBe(true);
    expect(isAllowedEmbedUrl('framer', 'https://acme.framer.app/page?x=1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isAllowedEmbedUrl('framer', 'http://acme.framer.app/')).toBe(false);
    expect(isAllowedEmbedUrl('framer', 'https://evil.example/?u=framer.app')).toBe(false);
    expect(isAllowedEmbedUrl('framer', 'https://framer.app.evil.example/')).toBe(false);
    expect(isAllowedEmbedUrl('framer', 'https://a.b.framer.app/')).toBe(false);
    expect(isAllowedEmbedUrl('builder', 'https://user:pw@cdn.builder.io/')).toBe(false);
    expect(isAllowedEmbedUrl('framer', 'https://acme.framer.website.evil.example/')).toBe(false);
    expect(isAllowedEmbedUrl('builder', 'not a url')).toBe(false);
    expect(isAllowedEmbedUrl('html', 'https://cdn.builder.io/')).toBe(false);
    expect(isAllowedEmbedUrl('builder', undefined)).toBe(false);
  });
});

describe('embedSource', () => {
  const ok = (value: unknown) => embedSource(value, {});

  it('requires exactly the source the provider needs', async () => {
    expect(await ok({ provider: 'html', html: '<p>Hi</p>', title: 'x' })).toBe(true);
    expect(await ok({ provider: 'framer', url: 'https://a.framer.app/', title: 'x' })).toBe(true);
    expect(await ok({ provider: 'html' })).toMatch(/Paste the HTML/);
    expect(await ok({ provider: 'html', html: '<p/>', url: 'https://a.framer.app/' })).toMatch(
      /has no URL/,
    );
    expect(await ok({ provider: 'builder' })).toMatch(/Enter the builder page URL/);
    expect(await ok({ provider: 'builder', html: '<p/>' })).toMatch(/uses the URL/);
    expect(await ok({ provider: 'framer', url: 'https://evil.example/' })).toMatch(
      /Must be an https:\/\/ URL on/,
    );
    expect(await ok({})).toBe(true); // provider required() reports the missing provider
  });
});

describe('campaign landing with an embed', () => {
  it('the fixture (Framer embed) validates', async () => {
    const errors = await validateDocument(
      campaignLandingFixture as unknown as Record<string, unknown>,
      schemaTypes,
    );
    expect(errors).toEqual([]);
  });

  it('rejects a wrong host, an over-long snippet and a silly height', async () => {
    const doc = clone(campaignLandingFixture) as unknown as {
      blocks: Record<string, unknown>[];
    } & Record<string, unknown>;
    const embed = doc.blocks.find((b) => b['_type'] === 'embed')!;
    embed['url'] = 'https://evil.example/';
    const hostErrors = await validateDocument(doc, schemaTypes);
    expect(hostErrors.map((e) => e.path)).toEqual(['blocks[1]']);

    embed['provider'] = 'html';
    delete embed['url'];
    embed['html'] = 'x'.repeat(EMBED_HTML_MAX_LENGTH + 1);
    embed['height'] = EMBED_HEIGHT.max + 1;
    const errors = await validateDocument(doc, schemaTypes);
    expect(errors.map((e) => e.path).sort()).toEqual(['blocks[1].height', 'blocks[1].html']);
  });

  it('embeds are only available on campaign landings, not on pages', async () => {
    const page = schemaTypes.find((t) => t.name === 'page')!;
    const campaign = schemaTypes.find((t) => t.name === 'campaignLanding')!;
    const memberTypes = (name: string, type = page) =>
      type.fields!.find((f) => f.name === name)!.of!.map((m) => m.type);
    expect(memberTypes('blocks')).not.toContain('embed');
    expect(memberTypes('blocks', campaign)).toContain('embed');
  });
});
