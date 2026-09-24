import { describe, expect, it } from 'vitest';
import { isKnownField, mapServerError } from '@/lib/forms/server-errors';
import { toActionResult } from '@/lib/forms/action-result';

const FIELDS = ['code', 'name', 'handle', 'options'];

describe('mapServerError', () => {
  it('puts a 400 validation_error under the field it names', () => {
    expect(
      mapServerError(
        {
          status: 400,
          error: {
            code: 'validation_error',
            message: 'handle must be kebab-case',
            details: { field: 'handle' },
          },
        },
        FIELDS,
      ),
    ).toEqual({ fieldErrors: { handle: 'handle must be kebab-case' }, formError: null });
  });

  it('puts a 409 conflict under the field too', () => {
    expect(
      mapServerError(
        {
          status: 409,
          error: {
            code: 'conflict',
            message: 'handle already exists',
            details: { field: 'handle' },
          },
        },
        FIELDS,
      ),
    ).toEqual({ fieldErrors: { handle: 'handle already exists' }, formError: null });
  });

  it('raises an unknown field to form level, keeping the field name visible', () => {
    // Attaching this to an input the form does not render would hide it completely.
    const errors = mapServerError(
      {
        status: 400,
        error: {
          code: 'validation_error',
          message: 'psp_account_id is not configured',
          details: { field: 'psp_account_id' },
        },
      },
      FIELDS,
    );
    expect(errors.fieldErrors).toEqual({});
    expect(errors.formError).toEqual('psp_account_id is not configured (field: psp_account_id)');
  });

  it('attaches a nested path to the form that owns its root', () => {
    const errors = mapServerError(
      {
        status: 400,
        error: {
          code: 'validation_error',
          message: 'values must be unique',
          details: { field: 'options.0.values' },
        },
      },
      FIELDS,
    );
    expect(errors.fieldErrors).toEqual({ 'options.0.values': 'values must be unique' });
  });

  it('explains a 403 in terms of the missing relation', () => {
    expect(
      mapServerError({
        status: 403,
        error: {
          code: 'forbidden',
          message: 'requires store_admin',
          details: { relation: 'store_admin', object: 'store:brand-a' },
        },
      }).formError,
    ).toEqual('You need the store_admin relation on store:brand-a to save this.');
  });

  it('falls back for a 403 with no details', () => {
    expect(
      mapServerError({ status: 403, error: { code: 'forbidden', message: 'no' } }).formError,
    ).toEqual('You do not have permission to save this.');
  });

  it('says the API is unreachable rather than showing a transport message', () => {
    expect(
      mapServerError({ status: 0, error: { code: 'network_error', message: 'ECONNREFUSED' } })
        .formError,
    ).toContain('Could not reach the Admin API');
  });

  it('passes a 500 message through at form level', () => {
    expect(mapServerError({ status: 500, error: { code: 'internal', message: 'boom' } })).toEqual({
      fieldErrors: {},
      formError: 'boom',
    });
  });

  it('does not invent a field error when the server names none', () => {
    expect(
      mapServerError(
        { status: 400, error: { code: 'validation_error', message: 'bad request' } },
        FIELDS,
      ),
    ).toEqual({ fieldErrors: {}, formError: 'bad request' });
  });

  it('ignores a non-string field in details', () => {
    const errors = mapServerError(
      { status: 400, error: { code: 'validation_error', message: 'bad', details: { field: 42 } } },
      FIELDS,
    );
    expect(errors.fieldErrors).toEqual({});
  });
});

describe('isKnownField', () => {
  it('matches exactly and by root segment', () => {
    expect(isKnownField('handle', FIELDS)).toBe(true);
    expect(isKnownField('options.0.name', FIELDS)).toBe(true);
    expect(isKnownField('options[0].name', FIELDS)).toBe(true);
    expect(isKnownField('theme.color', FIELDS)).toBe(false);
    expect(isKnownField('', FIELDS)).toBe(false);
  });
});

describe('toActionResult', () => {
  it('passes success straight through', () => {
    expect(toActionResult({ ok: true, status: 201, data: { id: 's1' } }, FIELDS)).toEqual({
      status: 'success',
      data: { id: 's1' },
    });
  });

  it('maps a failure onto the field the server named', () => {
    expect(
      toActionResult(
        {
          ok: false,
          status: 409,
          error: { code: 'conflict', message: 'code already exists', details: { field: 'code' } },
        },
        FIELDS,
      ),
    ).toEqual({ status: 'error', fieldErrors: { code: 'code already exists' }, formError: null });
  });
});

describe('pointer-keyed validation details (the core promotion validator)', () => {
  const failure = {
    status: 400,
    error: {
      code: 'validation_error',
      message: 'invalid promotion',
      details: {
        '/value': 'percentage value is basis points 1..10000',
        '/rules/buy_quantity': 'buy/get rules only apply to buy_x_get_y',
      },
    },
  };

  it('attaches each pointer to its field when the form renders it', () => {
    const mapped = mapServerError(failure, ['value', 'rules']);
    expect(mapped.fieldErrors).toEqual({
      value: 'percentage value is basis points 1..10000',
      'rules.buy_quantity': 'buy/get rules only apply to buy_x_get_y',
    });
    expect(mapped.formError).toBeNull();
  });

  it('raises the ones the form does not render to form level, named', () => {
    const mapped = mapServerError(failure, ['name']);
    expect(mapped.fieldErrors).toEqual({});
    expect(mapped.formError).toBe(
      'invalid promotion (value: percentage value is basis points 1..10000; rules.buy_quantity: buy/get rules only apply to buy_x_get_y)',
    );
  });

  it('does not change the documented { field } shape', () => {
    const mapped = mapServerError(
      {
        status: 400,
        error: { code: 'validation_error', message: 'bad handle', details: { field: 'handle' } },
      },
      ['handle'],
    );
    expect(mapped.fieldErrors).toEqual({ handle: 'bad handle' });
  });
});
