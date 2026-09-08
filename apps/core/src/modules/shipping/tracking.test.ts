// Webhook verification, parsing and the transition rules, without a database: the signature must be checked
// against the raw body, a body that is not a tracker update is rejected, and the status machine only ever moves
// forward.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canTransition, type ShipmentStatus } from './shipments';
import { parseEasyPostWebhook, verifyEasyPostSignature } from './tracking';

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

describe('parseEasyPostWebhook', () => {
  it('reads the tracker state, the carrier and the scan time', () => {
    const parsed = parseEasyPostWebhook(JSON.parse(webhookBody()));
    expect(parsed).toMatchObject({
      eventId: 'evt_123',
      topic: 'tracker.updated',
      event: {
        eventId: 'evt_123',
        trackingNumber: '1Z999',
        carrier: 'UPS',
        status: 'in_transit',
        statusDetail: 'Departed facility',
        occurredAt: '2026-09-08T09:00:00Z',
        location: { city: 'Köln', region: 'NRW', country: 'DE' },
      },
    });
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
    const parsed = parseEasyPostWebhook(body);
    expect(parsed!.event.status).toBe('delivered');
    expect(parsed!.event.occurredAt).toBe('2026-09-09T11:00:00Z');
  });

  it('maps an unknown carrier status to `unknown` rather than guessing', () => {
    const parsed = parseEasyPostWebhook(JSON.parse(webhookBody({ status: 'teleported' })));
    expect(parsed!.event.status).toBe('unknown');
  });

  it('returns null for anything that is not a tracker update', () => {
    expect(parseEasyPostWebhook({})).toBeNull();
    expect(parseEasyPostWebhook({ id: 'evt_1', result: {} })).toBeNull();
    expect(parseEasyPostWebhook({ result: { tracking_code: '1Z' } })).toBeNull();
  });
});

describe('shipment transitions', () => {
  const forward: [ShipmentStatus, ShipmentStatus][] = [
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
    expect(canTransition('label_created', 'cancelled')).toBe(true);
    expect(canTransition('shipped', 'cancelled')).toBe(false);
    expect(canTransition('in_transit', 'failed')).toBe(true);
    expect(canTransition('pending', 'failed')).toBe(true);
  });
});
