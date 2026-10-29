// Contract operation matcher (#632), unit. The every-operation walk over the real contracts and the agreement with
// Express live in apps/core/src/modules/hq-rbac/test/operation-matcher.test.ts (yaml + express resolve there).
import { describe, expect, it } from 'vitest';
import { createOperationMatcher } from '../src/index.js';

const op = (operationId: string) => ({ operationId });
const paths = {
  '/admin/stores/{storeId}/customers': { get: op('listCustomers') },
  '/admin/stores/{storeId}/customers/export': { get: op('exportCustomers') },
  '/admin/stores/{storeId}/customers/{customerId}': {
    get: op('getCustomer'),
    patch: op('updateCustomer'),
  },
  '/admin/me': { get: op('getMe'), parameters: [] },
};
const m = createOperationMatcher(paths);
const id = (method: string, path: string) => m.match(method, path)?.operationId ?? null;

describe('createOperationMatcher', () => {
  it('knows every operation with an operationId (non-method keys ignored)', () => {
    expect(m.operations.map((o) => o.operationId).sort()).toEqual(
      ['exportCustomers', 'getCustomer', 'getMe', 'listCustomers', 'updateCustomer'].sort(),
    );
  });

  it('matches by method and path; parameters take any non-empty segment', () => {
    expect(id('GET', '/admin/stores/s1/customers')).toBe('listCustomers');
    expect(id('GET', '/admin/stores/s1/customers/c1')).toBe('getCustomer');
    expect(id('PATCH', '/admin/stores/s1/customers/c1')).toBe('updateCustomer');
    expect(id('DELETE', '/admin/stores/s1/customers/c1')).toBeNull();
  });

  it('a literal segment beats a parameter', () => {
    expect(id('GET', '/admin/stores/s1/customers/export')).toBe('exportCustomers');
    expect(id('PATCH', '/admin/stores/s1/customers/export')).toBe('updateCustomer'); // no literal PATCH
  });

  it('Express defaults: case-insensitive literals, one optional trailing slash, HEAD = GET, query ignored', () => {
    expect(id('GET', '/ADMIN/Stores/s1/CUSTOMERS')).toBe('listCustomers');
    expect(id('get', '/admin/stores/s1/customers/')).toBe('listCustomers');
    expect(id('HEAD', '/admin/me')).toBe('getMe');
    expect(id('GET', '/admin/me?x=/admin/stores#frag')).toBe('getMe');
    expect(id('GET', '/admin/stores/s1/customers//')).toBeNull(); // only one trailing slash
  });

  it('nothing else is normalised: empty segments, dot segments and encoded slashes are not collapsed', () => {
    expect(id('GET', '/admin//stores/s1/customers')).toBeNull();
    expect(id('GET', '/admin/stores//customers')).toBeNull(); // an empty parameter matches nothing
    expect(id('GET', '/admin/x/../me')).toBeNull();
    expect(id('GET', '/admin/stores/s1%2Fcustomers/customers')).toBe('listCustomers'); // %2F stays in its segment
    expect(id('GET', '/admin/stores/s1/customers/%65xport')).toBe('getCustomer'); // never decoded for matching
  });

  it('refuses garbage input', () => {
    expect(m.match(undefined, '/admin/me')).toBeNull();
    expect(m.match('GET', undefined)).toBeNull();
    expect(id('GET', 'admin/me')).toBeNull();
    expect(id('GET', '')).toBeNull();
  });

  it('refuses ambiguous templates of one method at construction', () => {
    expect(() =>
      createOperationMatcher({ '/a/{x}': { get: op('one') }, '/a/{y}': { get: op('two') } }),
    ).toThrow(/ambiguous/);
    expect(() =>
      createOperationMatcher({ '/a/{x}/b': { get: op('one') }, '/a/c/{y}': { get: op('two') } }),
    ).not.toThrow(); // literal at position 1 decides
    expect(() =>
      createOperationMatcher({ '/a/{x}': { get: op('one') }, '/a/{y}': { post: op('two') } }),
    ).not.toThrow(); // different methods
  });
});
