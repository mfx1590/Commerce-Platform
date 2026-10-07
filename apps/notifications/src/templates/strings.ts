// Copy per locale. Every user-visible string of both templates lives here, so a new locale is one object and a
// wording change is one line. Values are plain text; the templates escape them.
import type { Locale } from '../types.js';

export interface Strings {
  lang: string;
  orderSubject(brand: string, displayId: number): string;
  shipSubject(brand: string, displayId: number): string;
  greeting(firstName: string | null): string;
  orderIntro: string;
  shipIntro: string;
  orderNumber: string;
  placedOn: string;
  shippedOn: string;
  item: string;
  quantity: string;
  amount: string;
  subtotal: string;
  discount(codes: string[]): string;
  shipping(method: string | null): string;
  tax: string;
  total: string;
  deliveryAddress: string;
  carrier: string;
  trackingNumber: string;
  trackParcel: string;
  itemsInParcel: string;
  questions(supportEmail: string): string;
  automated: string;
  vat: string;
  imprint: string;
  privacy: string;
}

const enGB: Strings = {
  lang: 'en',
  orderSubject: (brand, id) => `Your ${brand} order #${id} is confirmed`,
  shipSubject: (brand, id) => `Your ${brand} order #${id} is on its way`,
  greeting: (first) => (first ? `Hi ${first},` : 'Hello,'),
  orderIntro:
    'Thank you for your order. We have received it and will email you again as soon as it ships.',
  shipIntro: 'Good news: your parcel has been handed to the carrier.',
  orderNumber: 'Order number',
  placedOn: 'Placed on',
  shippedOn: 'Shipped on',
  item: 'Item',
  quantity: 'Qty',
  amount: 'Amount',
  subtotal: 'Subtotal',
  discount: (codes) => (codes.length > 0 ? `Discount (${codes.join(', ')})` : 'Discount'),
  shipping: (method) => (method ? `Shipping (${method})` : 'Shipping'),
  tax: 'VAT',
  total: 'Total',
  deliveryAddress: 'Delivery address',
  carrier: 'Carrier',
  trackingNumber: 'Tracking number',
  trackParcel: 'Track your parcel',
  itemsInParcel: 'In this parcel',
  questions: (support) => `Questions about your order? Write to ${support}.`,
  automated: 'You are receiving this email because you placed an order with us.',
  vat: 'VAT no.',
  imprint: 'Imprint',
  privacy: 'Privacy policy',
};

const deDE: Strings = {
  lang: 'de',
  orderSubject: (brand, id) => `Ihre Bestellung #${id} bei ${brand} ist bestätigt`,
  shipSubject: (brand, id) => `Ihre Bestellung #${id} bei ${brand} ist unterwegs`,
  greeting: (first) => (first ? `Hallo ${first},` : 'Guten Tag,'),
  orderIntro:
    'vielen Dank für Ihre Bestellung. Wir haben sie erhalten und melden uns per E-Mail, sobald sie versandt wurde.',
  shipIntro: 'gute Nachrichten: Ihr Paket wurde dem Versanddienstleister übergeben.',
  orderNumber: 'Bestellnummer',
  placedOn: 'Bestellt am',
  shippedOn: 'Versandt am',
  item: 'Artikel',
  quantity: 'Menge',
  amount: 'Betrag',
  subtotal: 'Zwischensumme',
  discount: (codes) => (codes.length > 0 ? `Rabatt (${codes.join(', ')})` : 'Rabatt'),
  shipping: (method) => (method ? `Versand (${method})` : 'Versand'),
  tax: 'MwSt.',
  total: 'Gesamtbetrag',
  deliveryAddress: 'Lieferadresse',
  carrier: 'Versanddienstleister',
  trackingNumber: 'Sendungsnummer',
  trackParcel: 'Sendung verfolgen',
  itemsInParcel: 'In diesem Paket',
  questions: (support) => `Fragen zu Ihrer Bestellung? Schreiben Sie an ${support}.`,
  automated: 'Sie erhalten diese E-Mail, weil Sie bei uns bestellt haben.',
  vat: 'USt-IdNr.',
  imprint: 'Impressum',
  privacy: 'Datenschutz',
};

export const strings: Readonly<Record<Locale, Strings>> = { 'en-GB': enGB, 'de-DE': deDE };
