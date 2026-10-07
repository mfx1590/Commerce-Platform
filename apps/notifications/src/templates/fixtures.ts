// Sample data for the preview route and the template tests. Invented, and the only "customer" this package
// ever renders outside a real delivery.
import type { NotificationData, NotificationKind } from '../types.js';

const ADDRESS = {
  first_name: 'Ada',
  last_name: 'Tester',
  line1: 'Keizersgracht 1',
  line2: null,
  city: 'Amsterdam',
  postal_code: '1015 AA',
  country: 'NL',
} as const;

export const FIXTURES: NotificationData = {
  order_confirmation: {
    displayId: 1042,
    placedAt: '2026-10-07T09:30:00.000Z',
    currency: 'EUR',
    shippingAddress: { ...ADDRESS },
    lines: [
      {
        title: 'Everyday Hoodie',
        variantTitle: 'Navy / M',
        sku: 'HOOD-NVY-M',
        quantity: 2,
        unitPriceMinor: 4500,
        totalMinor: 9000,
      },
      {
        title: 'Classic Cap',
        variantTitle: 'Classic Cap',
        sku: 'CAP-BLK',
        quantity: 1,
        unitPriceMinor: 1999,
        totalMinor: 1999,
      },
    ],
    totals: {
      subtotalMinor: 10999,
      discountMinor: 1000,
      shippingMinor: 495,
      taxMinor: 1821,
      totalMinor: 10494,
    },
    shippingMethod: { name: 'Standard', carrier: 'PostNL' },
    promotionCodes: ['WELCOME10'],
  },
  shipment_shipped: {
    displayId: 1042,
    shippedAt: '2026-10-08T14:05:00.000Z',
    carrier: 'PostNL',
    service: 'Standard',
    trackingNumber: '3SABCD123456789',
    trackingUrl: 'https://tracking.example/3SABCD123456789',
    items: [
      { title: 'Everyday Hoodie', variantTitle: 'Navy / M', quantity: 2 },
      { title: 'Classic Cap', variantTitle: 'Classic Cap', quantity: 1 },
    ],
    shippingAddress: { ...ADDRESS },
  },
};

export function fixtureFor<K extends NotificationKind>(kind: K): NotificationData[K] {
  return structuredClone(FIXTURES[kind]);
}
