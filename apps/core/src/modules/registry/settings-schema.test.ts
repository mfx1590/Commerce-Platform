import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { STORE_SETTINGS_SHAPES, settingsProblems, validateStoreSettings } from './settings-schema';

const valid = {
  payment: { invoice_allowed: true },
  support_refund_limit_minor: 5000,
  fulfillment: { provider: 'memory', routing: { default: 'wh-nl', countries: { DE: 'wh-de' } } },
  tax: { provider: 'stripe', prices_include_tax: true, shipping_taxable: false },
  shipping: {
    provider: 'easypost',
    carrier_account_ids: ['ca_x'],
    services: ['UPSGround'],
    default_parcel: { length_cm: 30, width_cm: 20, height_cm: 10, weight_g: 1000 },
    label_format: 'pdf',
  },
  fraud: {
    providers: ['rules'],
    velocity: { max_orders: 3, window_minutes: 60 },
    country_mismatch: 'allow',
    radar_highest: 'review',
  },
};

describe('store settings shape (#413)', () => {
  it('accepts every documented key with the right shape, and nothing to check at all', () => {
    expect(settingsProblems(valid)).toEqual({});
    expect(settingsProblems({})).toEqual({});
    expect(settingsProblems(undefined)).toEqual({});
  });

  it('names each offending key with what was expected', () => {
    expect(
      settingsProblems({
        payment: { invoice_allowed: 'yes' },
        support_refund_limit_minor: -1,
        fulfillment: { routing: { default: 7, countries: { Netherlands: 'wh' } } },
        tax: { provider: 'odoo', prices_include_tax: 1 },
        shipping: { carrier_account_ids: 'ca_x', default_parcel: { weight_g: 0 } },
        fraud: {
          providers: ['radar', 'ml'],
          velocity: { max_orders: 2.5 },
          radar_highest: 'allow',
        },
      }),
    ).toEqual({
      'payment.invoice_allowed': 'boolean',
      support_refund_limit_minor: 'integer >= 0',
      'fulfillment.routing.default': 'string or null',
      'fulfillment.routing.countries': 'object of ISO-3166-1 alpha-2 country → warehouse code',
      'tax.provider': 'one of table, stripe',
      'tax.prices_include_tax': 'boolean',
      'shipping.carrier_account_ids': 'array of strings',
      'shipping.default_parcel.weight_g': 'integer >= 1',
      'fraud.providers': 'array of rules | radar',
      'fraud.velocity.max_orders': 'integer >= 1',
      'fraud.radar_highest': 'one of block, review',
    });
  });

  it('reports a scalar where a group is expected once, at the group', () => {
    expect(settingsProblems({ tax: 5, fraud: [] })).toEqual({ tax: 'object', fraud: 'object' });
  });

  it('ignores keys it does not know (other modules add their own) and refuses the derived one', () => {
    expect(settingsProblems({ marketing: { anything: 1 }, payment: { gateway: 'x' } })).toEqual({});
    expect(settingsProblems({ payment: { methods: ['card'] } })).toEqual({
      'payment.methods': 'derived by the server (never stored)',
    });
  });

  it('a non-object settings value is one problem', () => {
    expect(settingsProblems('nope')).toEqual({ settings: 'object' });
    expect(settingsProblems([])).toEqual({ settings: 'object' });
  });

  it('validateStoreSettings throws the contract 422 validation_error with details.settings', () => {
    expect(() => validateStoreSettings(valid)).not.toThrow();
    let caught: unknown;
    try {
      validateStoreSettings({ payment: { invoice_allowed: 'yes' } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe('validation_error');
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ settings: { 'payment.invoice_allowed': 'boolean' } });
  });

  it('every group listed has its leaves listed under it (README and schema stay in step)', () => {
    const paths = Object.keys(STORE_SETTINGS_SHAPES);
    for (const p of paths) {
      const parent = p.split('.').slice(0, -1).join('.');
      if (parent) expect(paths, `${p} needs its group ${parent}`).toContain(parent);
    }
  });
});
