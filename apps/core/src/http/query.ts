import type { Request } from 'express';
import { validationError } from '../lib/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First value of a query/path parameter, or undefined. */
export function one(v: unknown): string | undefined {
  if (Array.isArray(v)) return one(v[0]);
  return typeof v === 'string' ? v : undefined;
}

export function intParam(
  query: Request['query'],
  name: string,
  { min, max }: { min: number; max?: number },
  problems: Record<string, string>,
): number | undefined {
  const raw = one(query[name]);
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    problems[name] = max !== undefined ? `integer between ${min} and ${max}` : `integer >= ${min}`;
    return undefined;
  }
  return n;
}

/** `page` / `limit` per the contracts' `Page` / `Limit` parameters (limit 1..100). */
export function pageParams(
  query: Request['query'],
  defaultLimit: number,
  problems: Record<string, string>,
): { page: number; limit: number } {
  const page = intParam(query, 'page', { min: 1 }, problems) ?? 1;
  const limit = intParam(query, 'limit', { min: 1, max: 100 }, problems) ?? defaultLimit;
  return { page, limit };
}

/** A path parameter that must be a uuid (400 otherwise). */
export function uuidParam(params: Request['params'], name: string): string {
  const v = one(params[name]);
  if (!v || !UUID.test(v)) throw validationError(`${name} must be a uuid`, { [name]: 'uuid' });
  return v;
}

export function throwIfProblems(problems: Record<string, string>): void {
  if (Object.keys(problems).length) throw validationError('invalid query', problems);
}
