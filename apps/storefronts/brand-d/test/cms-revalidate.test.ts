import { describe, expect, it, vi } from 'vitest';
import type { CmsConfig } from '@/lib/cms/config';
import { handleRevalidate } from '@/lib/cms/handlers';
import {
  SIGNATURE_HEADER,
  signWebhook,
  tagsForWebhook,
  verifyWebhookSignature,
} from '@/lib/cms/revalidate';

const NOW = 1_800_000_000_000;
const SECRET = 'webhook-secret';
const CONFIG: CmsConfig = {
  projectId: 'abc123',
  apiVersion: '2025-02-19',
  readToken: null,
  previewSecret: null,
  webhookSecret: SECRET,
};
const BODY = JSON.stringify({
  _id: 'page.en-GB.about',
  _type: 'page',
  locale: 'en-GB',
  slug: 'about',
});

describe('verifyWebhookSignature', () => {
  it('accepts Sanity’s t=…,v1=… header over "<t>.<body>"', () => {
    expect(verifyWebhookSignature(SECRET, signWebhook(SECRET, NOW, BODY), BODY, NOW)).toEqual({
      ok: true,
    });
  });

  it('rejects missing, malformed, stale, tampered and wrongly-keyed signatures', () => {
    const header = signWebhook(SECRET, NOW, BODY);
    expect(verifyWebhookSignature(SECRET, null, BODY, NOW)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(verifyWebhookSignature(SECRET, 'v1=abc', BODY, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyWebhookSignature(SECRET, header, BODY, NOW + 6 * 60 * 1000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyWebhookSignature(SECRET, header, BODY + ' ', NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature('other', header, BODY, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature(SECRET, `t=${NOW},v1=short`, BODY, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });
});

describe('tagsForWebhook', () => {
  it('maps a document to all three tag levels, a slug object too', () => {
    expect(tagsForWebhook({ _type: 'page', locale: 'en-GB', slug: 'about' })).toEqual([
      'cms',
      'cms:page',
      'cms:page:en-GB:about',
    ]);
    expect(
      tagsForWebhook({ _type: 'legal', locale: 'de-DE', slug: { current: 'privacy' } }),
    ).toEqual(['cms', 'cms:legal', 'cms:legal:de-DE:privacy']);
    expect(tagsForWebhook({ _type: 'navigation', locale: 'en-GB', key: 'main' })).toEqual([
      'cms',
      'cms:navigation',
      'cms:navigation:en-GB:main',
    ]);
  });

  it('falls back to coarser tags when fields or the type are unknown', () => {
    expect(tagsForWebhook({ _type: 'page' })).toEqual(['cms', 'cms:page']);
    expect(tagsForWebhook({ _type: 'sanity.imageAsset' })).toEqual(['cms']);
    expect(tagsForWebhook(null)).toEqual(['cms']);
  });
});

describe('handleRevalidate', () => {
  const request = (body: string, header: string | null) =>
    new Request('http://localhost:3100/api/cms/revalidate', {
      method: 'POST',
      body,
      headers: header === null ? {} : { [SIGNATURE_HEADER]: header },
    });

  it('revalidates the document’s tags on a valid signature', async () => {
    const revalidateTag = vi.fn();
    const response = await handleRevalidate(request(BODY, signWebhook(SECRET, NOW, BODY)), {
      config: CONFIG,
      revalidateTag,
      now: () => NOW,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revalidated: ['cms', 'cms:page', 'cms:page:en-GB:about'],
    });
    expect(revalidateTag.mock.calls.map((c) => c[0])).toEqual([
      'cms',
      'cms:page',
      'cms:page:en-GB:about',
    ]);
  });

  it('rejects a bad signature with 401 and touches nothing', async () => {
    const revalidateTag = vi.fn();
    const response = await handleRevalidate(request(BODY, signWebhook('other', NOW, BODY)), {
      config: CONFIG,
      revalidateTag,
      now: () => NOW,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_signature', reason: 'mismatch' });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('refuses to run without a webhook secret (503) and rejects non-JSON bodies (400)', async () => {
    const revalidateTag = vi.fn();
    expect(
      (
        await handleRevalidate(request(BODY, signWebhook(SECRET, NOW, BODY)), {
          config: { ...CONFIG, webhookSecret: null },
          revalidateTag,
        })
      ).status,
    ).toBe(503);
    const bad = 'not json';
    expect(
      (
        await handleRevalidate(request(bad, signWebhook(SECRET, NOW, bad)), {
          config: CONFIG,
          revalidateTag,
          now: () => NOW,
        })
      ).status,
    ).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
