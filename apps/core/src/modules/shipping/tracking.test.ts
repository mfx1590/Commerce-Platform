// Webhook verification, redacted extraction and the transition rules, without a database: the signature must be
// checked against the raw body, the extract keeps ids/status/timestamps and nothing that locates a person (#187),
// a body that is not a tracker update is rejected, and the status machine only ever moves forward.
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canTransition, type ShipmentStatus } from './shipments';
import { extractEasyPostWebhook, verifyEasyPostSignature } from './tracking';
import { payloadHashOf } from './webhook-events';

const SECRET = 'whsec_test_shipping';
const sign = (body: string, secret = SECRET) =>
  `hmac-sha256-hex=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

const webhookBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_123',
    description: 'tracker.updated',
    result: {
      id: 'trk_1',
      tracking_code: '1Z999',
      carrier: 'UPS',
      status: 'in_transit',
      status_detail: 'Departed facility',
      updated_at: '2026-09-08T10:00:00Z',
      signed_by: 'Jane Doe',
      destination: { street1: 'Keizersgracht 1', city: 'Amsterdam', zip: '1015 CJ', country: 'NL' },
      tracking_details: [
        {
          object_id: 'evtd_1',
          status: 'in_transit',
          message: 'Departed',
          datetime: '2026-09-08T09:00:00Z',
          tracking_location: { city: 'Köln', state: 'NRW', country: 'DE' },
        },
      ],
      ...over,
    },
  });

describe('EasyPost webhook signature', () => {
  it('accepts a correct signature over the raw body, with or without the algorithm prefix', () => {
    const body = webhookBody();
    expect(verifyEasyPostSignature(body, sign(body), SECRET)).toBe(true);
    const bare = sign(body).split('=')[1]!;
    expect(verifyEasyPostSignature(body, bare, SECRET)).toBe(true);
    expect(verifyEasyPostSignature(body, `  ${bare.toUpperCase()}  `, SECRET)).toBe(true);
  });

  it("rejects another provider's label, even when the digest itself is right", () => {
    const body = webhookBody();
    const digest = sign(body).split('=')[1]!;
    // A correct HMAC under a header shape we do not speak must not be accepted.
    expect(verifyEasyPostSignature(body, `sha1=${digest}`, SECRET)).toBe(false);
    expect(verifyEasyPostSignature(body, `v0=${digest}`, SECRET)).toBe(false);
    expect(verifyEasyPostSignature(body, `t=123,v1=${digest}`, SECRET)).toBe(false);
    // The label EasyPost actually sends, and a bare digest, still pass.
    expect(verifyEasyPostSignature(body, `hmac-sha256-hex=${digest}`, SECRET)).toBe(true);
    expect(verifyEasyPostSignature(body, `HMAC-SHA256-HEX=${digest}`, SECRET)).toBe(true);
    expect(verifyEasyPostSignature(body, digest, SECRET)).toBe(true);
  });

  it('rejects a wrong secret, a tampered body, a missing signature and an empty secret', () => {
    const body = webhookBody();
    expect(verifyEasyPostSignature(body, sign(body, 'other'), SECRET)).toBe(false);
    expect(verifyEasyPostSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyEasyPostSignature(body, null, SECRET)).toBe(false);
    expect(verifyEasyPostSignature(body, '', SECRET)).toBe(false);
    expect(verifyEasyPostSignature(body, sign(body), '')).toBe(false);
    expect(verifyEasyPostSignature(body, 'hmac-sha256-hex=deadbeef', SECRET)).toBe(false);
  });
});

describe('extractEasyPostWebhook', () => {
  it('keeps exactly the fields shipping processes', () => {
    expect(extractEasyPostWebhook(JSON.parse(webhookBody()))).toEqual({
      provider_event_id: 'evt_123',
      event_type: 'tracker.updated',
      tracker_id: 'trk_1',
      tracking_code: '1Z999',
      carrier: 'UPS',
      status: 'in_transit',
      occurred_at: '2026-09-08T09:00:00Z',
    });
  });

  it('drops every address, name and scan location (#187: no raw payloads, no PII)', () => {
    const extract = JSON.stringify(extractEasyPostWebhook(JSON.parse(webhookBody())));
    for (const pii of ['Keizersgracht', 'Amsterdam', '1015 CJ', 'Jane Doe', 'Köln', 'NRW']) {
      expect(extract).not.toContain(pii);
    }
  });

  it('prefers the tracker status over the last detail (EasyPost resends the whole history)', () => {
    const body = JSON.parse(
      webhookBody({
        status: 'delivered',
        tracking_details: [
          { object_id: 'd1', status: 'in_transit', datetime: '2026-09-08T09:00:00Z' },
          { object_id: 'd2', status: 'delivered', datetime: '2026-09-09T11:00:00Z' },
        ],
      }),
    );
    const extract = extractEasyPostWebhook(body);
    expect(extract!.status).toBe('delivered');
    expect(extract!.occurred_at).toBe('2026-09-09T11:00:00Z');
  });

  it('leaves occurred_at null when the carrier sent no timestamp, never a placeholder date', () => {
    const body = JSON.parse(webhookBody({ updated_at: undefined, tracking_details: [] }));
    expect(extractEasyPostWebhook(body)!.occurred_at).toBeNull();
  });

  it('maps an unknown carrier status to `unknown` rather than guessing', () => {
    expect(extractEasyPostWebhook(JSON.parse(webhookBody({ status: 'teleported' })))!.status).toBe(
      'unknown',
    );
  });

  it('returns null for anything that is not a tracker update', () => {
    expect(extractEasyPostWebhook({})).toBeNull();
    expect(extractEasyPostWebhook(null)).toBeNull();
    expect(extractEasyPostWebhook({ id: 'evt_1', result: {} })).toBeNull();
    expect(extractEasyPostWebhook({ result: { tracking_code: '1Z' } })).toBeNull();
    expect(extractEasyPostWebhook({ id: 7, result: { tracking_code: '1Z' } })).toBeNull();
  });
});

describe('payloadHashOf', () => {
  it('is the sha256 hex of the exact bytes, the same for a string or a Buffer', () => {
    const raw = webhookBody();
    const expected = createHash('sha256').update(raw).digest('hex');
    expect(payloadHashOf(raw)).toBe(expected);
    expect(payloadHashOf(Buffer.from(raw, 'utf8'))).toBe(expected);
    expect(payloadHashOf(`${raw} `)).not.toBe(expected);
  });
});

describe('shipment transitions', () => {
  const forward: [ShipmentStatus, ShipmentStatus][] = [
    ['pending', 'picking'],
    ['picking', 'packed'],
    ['packed', 'label_created'],
    ['packed', 'shipped'],
    ['pending', 'label_created'],
    ['pending', 'shipped'],
    ['label_created', 'shipped'],
    ['shipped', 'in_transit'],
    ['in_transit', 'delivered'],
    ['shipped', 'delivered'],
    ['label_created', 'delivered'],
  ];
  it.each(forward)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  const backward: [ShipmentStatus, ShipmentStatus][] = [
    ['picking', 'pending'],
    ['packed', 'picking'],
    ['label_created', 'packed'],
    ['picking', 'picking'],
    ['delivered', 'in_transit'],
    ['in_transit', 'shipped'],
    ['shipped', 'label_created'],
    ['label_created', 'pending'],
    ['delivered', 'delivered'],
    ['shipped', 'shipped'],
  ];
  it.each(backward)('refuses %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('treats delivered, failed and cancelled as final', () => {
    for (const from of ['delivered', 'failed', 'cancelled'] as ShipmentStatus[]) {
      for (const to of ['shipped', 'in_transit', 'delivered', 'failed'] as ShipmentStatus[]) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('allows cancelling only before the parcel moves, and failing at any live status', () => {
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('picking', 'cancelled')).toBe(true);
    expect(canTransition('packed', 'cancelled')).toBe(true);
    expect(canTransition('label_created', 'cancelled')).toBe(true);
    expect(canTransition('shipped', 'cancelled')).toBe(false);
    expect(canTransition('in_transit', 'failed')).toBe(true);
    expect(canTransition('pending', 'failed')).toBe(true);
  });
});
